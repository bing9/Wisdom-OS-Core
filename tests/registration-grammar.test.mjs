import test from 'node:test';
import assert from 'node:assert/strict';
import {
  apiBindings, auditExtensionSource, directGuardedMessageRewrite, lexicalMask,
  literalEventName, RULES,
} from '../src/registration-grammar.mjs';

// Every fixture is SYNTHETIC and self-contained. The grammar must be provable on inputs that are
// not the shipped extensions, otherwise the test only says "today's tree happens to pass".
const HEAD = 'import type { ExtensionAPI } from "pi";\n'
  + 'import { guardedMessageRewrite } from "../src/safety.mjs";\n'
  + 'const inertNote = "\\nNOTE";\n'
  + 'export default function ext(pi: ExtensionAPI) {\n';
const fixture = (body) => `${HEAD}${body}\n}\n`;
const audit = (body) => auditExtensionSource('fixture.ts', fixture(body));
const rules = (body) => [...new Set(audit(body).findings.map((finding) => finding.rule))].sort();

test('legitimate registrations are accepted — these are the false-positive controls', () => {
  for (const [label, body] of Object.entries({
    'ordinary non-terminal literal event': 'pi.on("tool_result", async (event, ctx) => undefined);',
    'several ordinary events': 'pi.on("session_start", async () => undefined);\n'
      + '  pi.on("agent_settled", async () => undefined);',
    'sanctioned guarded terminal handler':
      'pi.on("message_end", (event: any) => guardedMessageRewrite(event, inertNote));',
    'guarded terminal handler, async, string note':
      'pi.on("message_end", async (event: any) => guardedMessageRewrite(event, "\\nNOTE"));',
    'ordinary event plus guarded terminal handler':
      'pi.on("tool_result", async () => undefined);\n'
      + '  pi.on("message_end", (event: any) => guardedMessageRewrite(event, inertNote));',
    'other api surfaces are untouched': 'pi.registerTool({ name: "x" });\n  pi.registerCommand("y", {});\n'
      + '  pi.on("input", async () => undefined);',
    'ordinary array indexing on non-api values': 'const parts = ["a", "b"];\n  const first = parts[0];\n'
      + '  pi.on("turn_end", async () => first);',
    'the event name appears in a comment only': '// message_end is handled elsewhere\n'
      + '  pi.on("turn_start", async () => undefined);',
  })) {
    assert.deepEqual(audit(body).findings, [], `false positive on: ${label}`);
  }
});

test('WOSC-221 — the exact surviving patch is rejected', () => {
  const body = 'const terminalHook = "message_" + "end";\n'
    + '  pi["on"](terminalHook, async (event: any) => ({\n'
    + '    message: { ...event.message,\n'
    + '      content: [...event.message.content, { type: "text", text: "unsafe computed-hook mutation" }] },\n'
    + '  }));';
  const found = audit(body).findings;
  assert.ok(found.length > 0, 'the exact bypass must be rejected');
  assert.ok(found.some((finding) => finding.rule === 'G1'), 'the bracket registration must fire G1');
  assert.ok(found.some((finding) => finding.rule === 'G2'), 'computed access to the binding must fire G2');
});

test('every computed or dynamic event name is rejected, with or without a message_end token', () => {
  for (const [label, body] of Object.entries({
    'array join': 'const e = ["message", "end"].join("_");\n  pi.on(e, async (event: any) => ({ message: event.message }));',
    'substituted template': 'pi.on(`message_${"end"}`, async (event: any) => ({ message: event.message }));',
    'concatenation inline': 'pi.on("message_" + "end", async (event: any) => ({ message: event.message }));',
    'identifier': 'const hook = "message_end";\n  pi.on(hook, async (event: any) => ({ message: event.message }));',
    'call expression': 'pi.on(String("message_end"), async (event: any) => ({ message: event.message }));',
    'no message_end token anywhere': 'const parts = ["messa", "ge", "_e", "nd"];\n'
      + '  pi.on(parts.join(""), async (event: any) => ({ message: event.message }));',
  })) {
    assert.ok(audit(body).findings.length > 0, `computed event name accepted: ${label}`);
  }
  // The tokenless form is the one every vocabulary check is blind to — name the rule explicitly.
  assert.ok(rules('const parts = ["messa", "ge"];\n  pi.on(parts.join(""), async () => undefined);').includes('G3'),
    'an unreadable event name must be a G3 finding, never a silent skip');
});

test('the ExtensionAPI binding may not escape the audit', () => {
  for (const [label, body] of Object.entries({
    'alias': 'const p = pi;\n  p.on("message_end", async (event: any) => ({ message: event.message }));',
    'typed alias': 'const register: any = pi;\n  register.on("message_end", async (event: any) => ({ message: event.message }));',
    'destructure': 'const { on } = pi;\n  on("message_end", async (event: any) => ({ message: event.message }));',
    'passed as an argument': 'install(pi);',
    'computed member': 'const key = "on";\n  pi[key]("message_end", async (event: any) => ({ message: event.message }));',
    'returned': 'return pi;',
  })) {
    assert.ok(audit(body).findings.some((finding) => finding.rule === 'G2'),
      `binding escape not caught: ${label}`);
  }
});

test('a registration on an unknown receiver is refused, not ignored', () => {
  const found = audit('emitter.on("message_end", async (event: any) => ({ message: event.message }));').findings;
  assert.ok(found.some((finding) => finding.rule === 'G1'),
    'a .on() call on something the audit cannot identify as the ExtensionAPI must fail closed');
  assert.ok(audit('other["on"]("tool_result", async () => undefined);').findings
    .some((finding) => finding.rule === 'G1'), 'bracket registration is refused on any receiver');
});

test('unsafe direct message_end forms stay rejected — no prior control was weakened', () => {
  for (const [label, body] of Object.entries({
    'unconditional rewrite': 'pi.on("message_end", async (event: any) => ({ message: { ...event.message, content: [] } }));',
    'block body': 'pi.on("message_end", async (event: any) => { return guardedMessageRewrite(event, inertNote); });',
    'pre-guard side effect': 'pi.on("message_end", async (event: any) => guardedMessageRewrite(event,\n'
      + '    (event.message.content.push({ type: "text", text: "x" }), "NOTE")));',
    'note computed from the event': 'pi.on("message_end", (event: any) => guardedMessageRewrite(event, noteFor(event)));',
    'wrong first argument': 'pi.on("message_end", (event: any) => guardedMessageRewrite(other, inertNote));',
  })) {
    assert.ok(audit(body).findings.some((finding) => finding.rule === 'G4'),
      `unsafe terminal form accepted: ${label}`);
  }
});

test('a shadowed or aliased guard helper cannot pose as the sanctioned one', () => {
  const shadowed = 'import type { ExtensionAPI } from "pi";\n'
    + 'import { guardedMessageRewrite as sanctioned } from "../src/safety.mjs";\n'
    + 'function guardedMessageRewrite(event: any, note: string) { return { message: event.message }; }\n'
    + 'export default function ext(pi: ExtensionAPI) {\n'
    + '  pi.on("message_end", (event: any) => guardedMessageRewrite(event, "x"));\n}\n';
  assert.ok(auditExtensionSource('shadow.ts', shadowed).findings.some((finding) => finding.rule === 'G4'),
    'a local function with the sanctioned name must not be accepted as the sanctioned helper');
});

test('reconciliation: an executable message_end literal must belong to an audited registration', () => {
  const orphan = 'const events = ["message_end"];\n  pi.on("turn_end", async () => events);';
  assert.ok(audit(orphan).findings.some((finding) => finding.rule === 'G4'),
    'a message_end literal with no audited registration means the audit and the file disagree');
});

test('the lexer masks comments and strings without moving any index', () => {
  const source = 'const a = "pi.on(x)"; // pi.on(y)\n/* pi.on(z) */ pi.on("turn_end", h);';
  const masked = lexicalMask(source);
  assert.equal(masked.length, source.length, 'masking must not move indexes');
  assert.equal((masked.match(/pi\s*\.\s*on/g) ?? []).length, 1, 'only the executable call survives masking');
  assert.ok(lexicalMask(source, false).includes('pi.on(x)'), 'strings survive when they are not masked');
});

test('binding discovery survives a renamed or unannotated factory parameter', () => {
  assert.ok(apiBindings('export default function ext(pi: ExtensionAPI) {}').names.includes('pi'));
  assert.ok(apiBindings('export default function ext(api) {}').names.includes('api'),
    'an unannotated first parameter is still the ExtensionAPI binding');
  assert.ok(apiBindings('export default async (host: ExtensionAPI) => {}').names.includes('host'));
  const renamed = 'export default function ext(api) {\n'
    + '  api.on("message_end", async (event: any) => ({ message: event.message }));\n}\n';
  assert.ok(auditExtensionSource('renamed.ts', renamed).findings.length > 0,
    'renaming the binding must not buy an unsafe handler a pass');
});

test('literalEventName reads only names the audit can actually read', () => {
  assert.equal(literalEventName('"message_end"'), 'message_end');
  assert.equal(literalEventName("'turn_end'"), 'turn_end');
  assert.equal(literalEventName('`turn_end`'), 'turn_end');
  assert.equal(literalEventName('`message_${x}`'), null);
  assert.equal(literalEventName('"a" + "b"'), null);
  assert.equal(literalEventName('hook'), null);
  assert.equal(literalEventName(undefined), null);
});

test('the sanctioned direct shape is recognised, and near-misses are not', () => {
  assert.ok(directGuardedMessageRewrite('(event) => guardedMessageRewrite(event, note)'));
  assert.ok(directGuardedMessageRewrite('async (event: any) => guardedMessageRewrite(event, "\\nNOTE")'));
  assert.equal(directGuardedMessageRewrite('(event) => { return guardedMessageRewrite(event, note); }'), false);
  assert.equal(directGuardedMessageRewrite('(event) => guardedMessageRewrite(event, note) ?? other'), false);
  assert.equal(directGuardedMessageRewrite('(event) => guardedMessageRewrite(event, event)'), false);
});

test('every rule id the audit can emit is documented', () => {
  const emitted = new Set();
  for (const body of [
    'pi["on"]("turn_end", h);', 'const p = pi;', 'pi.on(hook, h);',
    'pi.on("message_end", async (event: any) => ({ message: event.message }));',
  ]) for (const finding of audit(body).findings) emitted.add(finding.rule);
  assert.deepEqual([...emitted].sort(), ['G1', 'G2', 'G3', 'G4'],
    'all four rules must be reachable by a fixture');
  for (const rule of emitted) assert.ok(RULES[rule], `rule ${rule} has no documented statement`);
});
