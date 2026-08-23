#!/usr/bin/env node
/**
 * The release gate. One command.
 *
 *   node scripts/release-check.mjs             positive gate — every check must pass, exit 0
 *   node scripts/release-check.mjs --negative  mutation test — every mutation must be caught
 *   node scripts/release-check.mjs --child     internal: one positive run inside a mutated copy
 *
 * Exit codes
 *   0  positive gate passed
 *   1  positive gate failed, or a mutation SURVIVED (the gate is not a gate)
 *   3  negative gate succeeded: every mutation was killed. Non-zero by design — `--negative`
 *      asserts that the tree is rejectable, so a zero here would be indistinguishable from
 *      "nothing was tested".
 *
 * THE RUNTIME IS PART OF THE RESULT. Two Node majors on one host report different pass counts for
 * the same suite (v16 counts files, v24 counts subtests). A bare "15 pass" is not reproducible, so
 * every run prints its own execPath and version before anything else.
 */
import { spawn } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// ONE grammar, imported — never restated here. WOSC-221: the gate and `scripts/extension-audit.mjs`
// must be unable to disagree about what a legal Pi registration is.
import { auditExtensionSource, auditExtensionSources, directGuardedMessageRewrite, formatFinding, RULES }
  from '../src/registration-grammar.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
const NEGATIVE = argv.includes('--negative');
const CHILD = argv.includes('--child');

const read = (rel) => readFile(join(ROOT, rel), 'utf8');
const exists = async (rel) => { try { await stat(join(ROOT, rel)); return true; } catch { return false; } };

function run(command, args, options = {}) {
  return new Promise((done) => {
    const child = spawn(command, args, { cwd: ROOT, ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => done({ code: 127, stdout, stderr: String(error?.message ?? error) }));
    child.on('close', (code) => done({ code: code ?? 1, stdout, stderr }));
  });
}

const ok = (detail) => ({ ok: true, detail });
const bad = (detail) => ({ ok: false, detail });
function assert(condition, message) { if (!condition) throw new Error(message); }

// ── release checks ───────────────────────────────────────────────────────────────────────────

const CHECKS = [
  {
    id: 'unit-suite',
    title: 'unit / domain / store / CLI / package behaviour',
    async run() {
      const files = (await readdir(join(ROOT, 'tests'))).filter((name) => name.endsWith('.test.mjs')).sort();
      assert(files.length > 0, 'no test files found');
      const result = await run(process.execPath, ['--test', ...files.map((name) => join('tests', name))]);
      // v16 prefixes the TAP summary with `#`, v24 with `ℹ`, and v16 counts FILES where v24 counts
      // subtests. Both are accepted; the number is only ever reported next to its runtime.
      const counts = /[#ℹ] tests (\d+)[\s\S]*?[#ℹ] pass (\d+)[\s\S]*?[#ℹ] fail (\d+)/.exec(result.stdout);
      const summary = counts ? `${counts[2]} pass / ${counts[3]} fail of ${counts[1]}` : 'no summary parsed';
      // The unit is runtime-dependent, so it is stated with the runtime rather than as a bare number.
      return result.code === 0
        ? ok(`${files.length} files · ${summary} under ${process.execPath} ${process.version}`)
        : bad(`suite failed (${summary})\n${result.stdout.slice(-1600)}`);
    },
  },
  {
    id: 'lifecycle-gates',
    title: 'evidence is separated from lifecycle; state version is pinned',
    async run() {
      const { validateTaskTransition, validateDecisionTransition } = await import(join(ROOT, 'src/domain.mjs'));
      const { normalizeState, validState } = await import(join(ROOT, 'src/store.mjs'));

      // The A39 shape: everything the evidence layer can produce, and it is still not DONE.
      const evidenced = { acceptance: 'a', maker: 'm', evidence: 'e', verifier: 'v', verification: 'r',
        acceptedByHuman: false };
      const done = validateTaskTransition(evidenced, 'done');
      assert(!done.ok && done.missing.includes('human acceptance'),
        'evidence passing must not be done — human acceptance is a separate axis');

      const selfVerified = validateTaskTransition({ ...evidenced, verifier: 'm', acceptedByHuman: true }, 'done');
      assert(!selfVerified.ok && selfVerified.missing.includes('independent verifier'),
        'maker must not be able to verify their own work');

      const banked = validateDecisionTransition({ humanCall: 'x' }, 'bank');
      assert(!banked.ok && banked.missing.length === 3, `bank must require owner, date, resolved premise: ${banked.missing}`);
      const learned = validateDecisionTransition({}, 'learn');
      assert(!learned.ok && learned.missing.length === 3, 'learn must require outcome, review, case-law change');

      // Versioned state: the schema version is stamped, and an unknown version is refused rather
      // than coerced. A silently upgraded state is an unversioned state.
      assert(normalizeState({}).version === 2, 'normalizeState must stamp the current version');
      assert(validState({ version: 3, areas: [], decisions: [], tasks: [], feedback: [], runs: [], history: [] }) === false,
        'an unknown state version must be refused');
      return ok('evidence ≠ lifecycle; maker ≠ verifier; bank/learn gated; version pinned at 2');
    },
  },
  {
    id: 'return-envelope',
    title: 'return transaction: completeness, independence, exact session, exactly-once, idle ≠ done',
    async run() {
      const mod = await import(join(ROOT, 'src/return-envelope.mjs'));
      const complete = { request_id: 'r1', producing_agent: 'p', reply_to_session_id: 's1', reply_runtime: 'pi',
        reply_to_agent: 'a', reply_policy: 'awaited-done', awaited_by: 'd', verified_by: 'v',
        missing_report_action: 're-steer-once' };
      // The expected field set is PINNED here, not read from the module. Iterating
      // REQUIRED_ENVELOPE_FIELDS to test REQUIRED_ENVELOPE_FIELDS is self-satisfying: delete a field
      // from the list and the loop simply stops testing it, so the gate weakens in silence.
      const EXPECTED = ['request_id', 'producing_agent', 'reply_to_session_id', 'reply_runtime',
        'reply_to_agent', 'reply_policy', 'awaited_by', 'verified_by', 'missing_report_action'];
      const declared = [...mod.REQUIRED_ENVELOPE_FIELDS].sort();
      assert(JSON.stringify(declared) === JSON.stringify([...EXPECTED].sort()),
        `the required-field set changed: declared [${declared}] vs pinned [${[...EXPECTED].sort()}]`);
      assert(mod.validateEnvelope(complete).ok, 'a complete envelope must validate');
      for (const field of EXPECTED) {
        const partial = { ...complete };
        delete partial[field];
        assert(!mod.validateEnvelope(partial).ok, `${field} must be required`);
      }
      assert(!mod.validateEnvelope({ ...complete, verified_by: 'p' }).ok, 'the producer must not verify itself');
      assert(!mod.exactSession({ reply_to_session_id: 's1' }, 's2'), 'a return must not cross sessions');

      const entries = [{ customType: 'wos-return', details: { request_id: 'r1' } }];
      const plan = mod.planDelivery(
        [{ request_id: 'r1', reply_to_session_id: 's1' }, { request_id: 'r2', reply_to_session_id: 's1' },
          { request_id: 'r2', reply_to_session_id: 's1' }, { request_id: 'r3', reply_to_session_id: 'other' }],
        's1', entries);
      assert(plan.inject.length === 1 && plan.inject[0].request_id === 'r2', 'exactly-once delivery failed');
      assert(plan.acknowledgeOnly.length === 2, 'already-delivered and in-batch duplicates must be acked, not re-sent');

      const idle = mod.settleOutcome({ requestId: 'r1', reports: [], idle: true, envelope: complete });
      assert(idle.outcome === 'returned-without-report' && idle.done === false,
        'idle with no correlated report must never read as done');
      assert(idle.recovery === 're-steer-once', 'the declared missing-report recovery must be surfaced');
      assert(!mod.routable({}).ok, 'a report with no recipient must not count as routable');
      return ok(`${mod.REQUIRED_ENVELOPE_FIELDS.length} required fields; idle → returned-without-report`);
    },
  },
  {
    id: 'improvement-governance',
    title: 'improvement loop: recurrence, semantic approval, canary, verifier, auto-disable',
    async run() {
      const { recordProcessSignal, validateImprovementTransition } = await import(join(ROOT, 'src/domain.mjs'));
      const base = { processSignals: [], improvements: [], tasks: [] };
      const signal = (n, semantic) => ({ id: `s${n}`, klass: 'wrong-scope', semantic });

      const once = recordProcessSignal(base, signal(1, true), 2, '2026-08-22T00:00:00.000Z');
      assert(once.improvements.length === 0, 'one occurrence is not a recurring class');
      const twice = recordProcessSignal(once, signal(2, true), 2, '2026-08-22T00:00:00.000Z');
      assert(twice.improvements.length === 1, 'a recurring class must open governed work');
      assert(twice.improvements[0].needsHumanApproval === true, 'a semantic class needs a human call');
      assert((twice.tasks ?? []).length === 0, 'a semantic proposal must not auto-queue work');

      const mechanical = recordProcessSignal(
        recordProcessSignal(base, { id: 'm1', klass: 'flaky-path', semantic: false }, 2, '2026-08-22T00:00:00.000Z'),
        { id: 'm2', klass: 'flaky-path', semantic: false }, 2, '2026-08-22T00:00:00.000Z');
      assert(mechanical.tasks.length === 1, 'a mechanical, reversible class may enter the queue automatically');

      const ready = { evidenceIds: ['a', 'b'], expectedEffect: 'x', falsifier: 'y', regressionTest: 't',
        rollback: 'r', autoDisable: 'q', needsHumanApproval: true };
      assert(!validateImprovementTransition(ready, 'canary').ok, 'a semantic control needs approval before canary');
      assert(validateImprovementTransition({ ...ready, approvedByHuman: true }, 'canary').ok, 'approval must unblock canary');
      assert(!validateImprovementTransition({ ...ready, approvedByHuman: true, autoDisable: '' }, 'canary').ok,
        'no control ships without a quality auto-disable');
      const live = { canaryResult: 'c', maker: 'm', verifier: 'v', autoDisable: 'q' };
      assert(validateImprovementTransition(live, 'live').ok, 'a fully governed control may go live');
      assert(!validateImprovementTransition({ ...live, verifier: 'm' }, 'live').ok, 'maker may not verify the control');
      assert(!validateImprovementTransition({ ...live, autoDisable: '' }, 'live').ok, 'auto-disable is required to go live');
      assert(!validateImprovementTransition({ ...live, canaryResult: '' }, 'live').ok, 'a canary result is required');
      return ok('recurrence → proposal → semantic approval → canary → verified live, each gate provable');
    },
  },
  {
    id: 'guard-fixtures',
    title: 'guard positive fixtures, false-positive controls, and gate provenance',
    async run() {
      const g = await import(join(ROOT, 'src/guard-predicates.mjs'));
      assert(g.transient('rc=124 timed out', false), 'positive: transient class');
      assert(!g.transient('Stale file handle', false), 'control: transient prose without a failure must not fire');
      assert(!g.transient('exit=1\nsyntax error', false), 'control: a deterministic failure is not transient');
      assert(g.noMatch('', 'grep -r foo .', 'bash'), 'positive: empty search');
      assert(!g.noMatch('', 'python3 build.py', 'bash'), 'control: a silent non-search is not an absence claim');
      assert(g.partialCoverage('Permission denied', 'grep -r foo /', 'bash'), 'positive: unreadable range');
      assert(!g.partialCoverage('Permission denied', 'chmod 600 f', 'bash'), 'control: not a search');

      const reachable = new Set([
        ...g.evaluateGates({ body: 'rc=124 timed out', command: 'ls', isError: true }),
        ...g.evaluateGates({ body: '', command: 'grep foo', toolName: 'bash' }),
        ...g.evaluateGates({ body: 'Permission denied', command: 'grep -r foo /', toolName: 'bash' }),
      ]);
      assert(reachable.size === g.GATE_IDS.length && g.GATE_IDS.every((id) => reachable.has(id)),
        'every declared gate must be reachable by a fixture, and no gate may fire undeclared');

      // The extension's declared manifest must equal the predicate module's id list.
      const source = await read('extensions/wos-guards.ts');
      assert(/GATES\s*=\s*GATE_IDS\.map/.test(source),
        'the extension must derive its gate manifest from the predicate ids, not restate them');

      const { gateCoverage, gateEvent, gateManifest } = await import(join(ROOT, 'src/gatelog.mjs'));
      const first = gateManifest([{ id: 'x', hook: 'tool_result', shipped: '2026-01-01' }], {}, '2026-08-22T00:00:00.000Z');
      const again = gateManifest([{ id: 'x', hook: 'tool_result', shipped: '2026-08-22' }], first, '2026-08-22T00:00:00.000Z');
      assert(again.gates.x.shipped === '2026-01-01', 'a redeploy must not re-date an existing gate');
      const coverage = gateCoverage(first, [gateEvent({ gateId: 'x', synthetic: true })]);
      assert(coverage.syntheticOnly.includes('x'),
        'a gate proven only by its own tests must be reported as synthetic-only, never as working');
      return ok(`${g.GATE_IDS.length} gates: positives fire, controls stay quiet, provenance is recorded`);
    },
  },
  {
    // Added 2026-08-22 after an independent verifier landed an unconditional unsafe `message_end`
    // writer and the gate accepted it 12/12 under both runtimes. The previous commit CLAIMED this
    // enforcement in two file headers and never implemented it — a claim-without-enforcement fix
    // for a claim-without-enforcement defect. This is the enforcement.
    //
    // WOSC-221, 2026-08-23. The enforcement was real but it read VOCABULARY: it scanned for the
    // token sequence `pi . on (` and reconciled against executable `"message_end"` literals.
    // `const h = "message_" + "end"; pi["on"](h, unsafe)` has neither, so the audit reported
    // `0 message_end handlers` and the gate passed 14/14. The check now runs a REGISTRATION
    // GRAMMAR first — direct dotted call, unaliased binding, literal event name — so a name the
    // audit cannot read is a finding instead of a silence, and only then does event-specific
    // policy apply. Same module as `scripts/extension-audit.mjs`; they cannot drift.
    id: 'terminal-message-safety',
    title: 'every Pi registration is literal, and no extension rewrites an assistant message without the terminal-message predicate',
    async run() {
      const safety = await import(join(ROOT, 'src/safety.mjs'));

      // 1. The predicate itself must refuse a mid-flight message.
      const midFlight = { message: { role: 'assistant', content: [{ type: 'text', text: 'x' }, { type: 'toolCall', id: 't' }] } };
      assert(safety.guardedMessageRewrite(midFlight, '\nNOTE') === undefined,
        'the sanctioned rewrite must refuse a message carrying a tool call');
      assert(safety.guardedMessageRewrite({ message: { role: 'user', content: [] } }, '\nNOTE') === undefined,
        'only assistant messages may be rewritten');
      const terminal = { message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } };
      const rewritten = safety.guardedMessageRewrite(terminal, '\nNOTE');
      assert(rewritten?.message?.content?.length === 2 && rewritten.message.content[0].text === 'done',
        'a terminal message must be appended to, with the original preserved');
      assert(directGuardedMessageRewrite('async (event: any) => guardedMessageRewrite(event, note)'),
        'the direct sanctioned handler shape must remain usable');

      // 2. FALSE-POSITIVE CONTROLS, run before the repository is judged. Fixtures the grammar must
      //    accept and fixtures it must reject, so a grammar that has stopped discriminating fails
      //    here rather than passing quietly over a clean tree.
      const API = 'import type { ExtensionAPI } from "pi";\n'
        + 'import { guardedMessageRewrite } from "../src/safety.mjs";\n'
        + 'const inertNote = "\\nNOTE";\n'
        + 'export default function ext(pi: ExtensionAPI) {\n';
      const fixture = (body) => `${API}${body}\n}\n`;
      const clean = (body) => auditExtensionSource('fixture.ts', fixture(body)).findings;
      const ACCEPT = {
        'ordinary literal event': 'pi.on("tool_result", async (event, ctx) => undefined);',
        'sanctioned guarded terminal handler':
          'pi.on("message_end", (event: any) => guardedMessageRewrite(event, inertNote));',
        'both together':
          'pi.on("session_start", async () => undefined);\n'
          + '  pi.on("message_end", (event: any) => guardedMessageRewrite(event, inertNote));',
      };
      const REJECT = {
        'computed name + bracket registration':
          'const h = "message_" + "end";\n  pi["on"](h, async (event: any) => ({ message: event.message }));',
        'array join computed name':
          'const e = ["message", "end"].join("_");\n  pi.on(e, async (event: any) => ({ message: event.message }));',
        'substituted template name':
          'pi.on(`message_${"end"}`, async (event: any) => ({ message: event.message }));',
        'aliased api binding': 'const p = pi;\n  p.on("message_end", async (event: any) => ({ message: event.message }));',
        'destructured registration': 'const { on } = pi;\n  on("message_end", async (event: any) => ({ message: event.message }));',
        'unsafe direct terminal handler':
          'pi.on("message_end", async (event: any) => ({ message: { ...event.message, content: [] } }));',
      };
      for (const [label, body] of Object.entries(ACCEPT)) {
        const findings = clean(body);
        assert(findings.length === 0,
          `FALSE POSITIVE — the grammar rejected a legitimate registration (${label}): ${findings.map(formatFinding).join('; ')}`);
      }
      for (const [label, body] of Object.entries(REJECT)) {
        assert(clean(body).length > 0, `the grammar accepted an unsafe registration (${label})`);
      }
      assert(directGuardedMessageRewrite('async (event: any) => guardedMessageRewrite(event, note)'),
        'the direct sanctioned handler shape must remain usable');

      // 3. Audit the repository. Every packaged extension, every registration — the manifest's
      //    declared entrypoints unioned with everything in `extensions/`, so a file that is shipped
      //    but undeclared, or declared but unlisted, is still judged.
      const pkg = JSON.parse(await read('package.json'));
      const names = new Set((pkg.pi?.extensions ?? []).map((entry) => entry.replace(/^\.\//, '')));
      for (const name of await readdir(join(ROOT, 'extensions'))) {
        if (/\.(ts|mjs|js)$/.test(name)) names.add(join('extensions', name));
      }
      const paths = [...names].sort();
      assert(paths.length > 0, 'no extensions found to audit');
      const entries = await Promise.all(paths.map(async (path) => [path, await read(path)]));
      const audit = auditExtensionSources(entries);
      assert(audit.findings.length === 0,
        `the extension registration grammar was violated:\n  ${audit.findings.map(formatFinding).join('\n  ')}\n  `
        + [...new Set(audit.findings.map((finding) => finding.rule))].sort()
          .map((rule) => `${rule}: ${RULES[rule]}`).join('\n  '));

      // 4. The standalone scanner must exist, be packaged, and agree with this check on this tree.
      //    A gate whose portable proof command is absent is a gate nobody outside can re-run.
      assert(await exists('scripts/extension-audit.mjs'), 'the standalone registration audit must ship');
      assert((pkg.files ?? []).includes('scripts/extension-audit.mjs'),
        'the standalone registration audit must be inside the package manifest');
      const standalone = await run(process.execPath, ['scripts/extension-audit.mjs']);
      assert(standalone.code === 0,
        `the standalone audit disagrees with this check on a clean tree:\n${standalone.stdout}${standalone.stderr}`);

      // 5. The headers that make the claim must name the enforcement, so the two cannot drift apart
      //    again without this check noticing.
      const guardsHeader = await read('extensions/wos-guards.ts');
      assert(/release-check/.test(guardsHeader) && /safety\.mjs/.test(guardsHeader),
        'the file claiming terminal-message safety must name where it is enforced');
      return ok(`${paths.length} extensions · ${audit.registrations} literal registrations · ${audit.terminalHandlers} message_end handler(s) · `
        + `${Object.keys(ACCEPT).length} accept + ${Object.keys(REJECT).length} reject controls · standalone audit agrees`);
    },
  },
  {
    id: 'read-only-zero-bytes',
    title: 'read-only mode writes zero bytes',
    async run() {
      const dir = await mkdtemp(join(tmpdir(), 'wos-ro-'));
      try {
        const statePath = join(dir, 'state.json');
        const env = { ...process.env, WISDOM_OS_STATE: statePath, WISDOM_OS_READ_ONLY: '1' };
        await run(process.execPath, ['cli.mjs', 'init'], { env });   // create it once, writably
        const before = await readFile(statePath, 'utf8');
        const beforeDir = (await readdir(dir)).sort();
        for (const args of [['butler'], ['list', 'task'], ['list', 'case'], ['precedents', 'anything'], ['init']]) {
          await run(process.execPath, ['cli.mjs', ...args], { env });
        }
        const after = await readFile(statePath, 'utf8');
        const afterDir = (await readdir(dir)).sort();
        assert(before === after, 'a read path changed the state file byte content');
        assert(JSON.stringify(beforeDir) === JSON.stringify(afterDir),
          `a read path created or removed files: ${beforeDir} -> ${afterDir}`);

        // Static half: every write-capable lifecycle hook must consult READ_ONLY. A runtime check
        // on the CLI cannot see the extension hooks, and those are where the writes live.
        const butler = await read('extensions/wos-butler.ts');
        assert(/const READ_ONLY = \/\^\(1\|true\|yes\)\$\/i\.test\(/.test(butler),
          'READ_ONLY must be derived from the environment, not hard-coded');
        // Read the hook's guard clause, not just its signature: the check on the line below the
        // arrow is the whole point, so the window has to be wide enough to contain it.
        const hooks = [...butler.matchAll(/pi\.on\("(input|tool_execution_end|agent_settled)"[\s\S]{0,300}/g)];
        assert(hooks.length === 3, `expected 3 write-capable hooks, found ${hooks.length}`);
        for (const [block, name] of hooks) {
          assert(/READ_ONLY/.test(block), `hook ${name} does not consult READ_ONLY`);
        }
        return ok(`${beforeDir.length} file(s), bytes identical after 5 read commands; 3 hooks gated`);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  },
  {
    id: 'restart-resume',
    title: 'restart restores durable state without replaying a transcript',
    async run() {
      const dir = await mkdtemp(join(tmpdir(), 'wos-resume-'));
      try {
        const statePath = join(dir, 'state.json');
        const { writeState } = await import(join(ROOT, 'src/store.mjs'));
        await writeState(statePath, {
          version: 2, revision: 7,
          areas: [{ id: 'area-1', name: 'Harness', director: 'Director' }],
          decisions: [{ id: 'd1', title: 'Port the return envelope', areaId: 'area-1', stage: 'bank',
            humanCall: 'port the contract only', owner: 'Owner', dueDate: '2026-09-01',
            resolvedPremise: 'transport stays private', priority: 'P0' }],
          tasks: [{ id: 't1', title: 'Write the gate', decisionId: 'd1', areaId: 'area-1', stage: 'verify',
            acceptance: 'negative mode kills a mutation', evidence: 'release-check.mjs', maker: 'producer' }],
          feedback: [], runs: [{ entityType: 'task', entityId: 't1', agent: 'pi', command: 'test',
            result: 'completed', artifact: 'scripts/release-check.mjs', createdAt: '2026-08-22T00:00:00.000Z' }],
          history: [], cases: [{ id: 'c1', claim: 'a gate that cannot fail is not a gate', status: 'active',
            falsifier: 'a mutation survives' }],
          precedentUses: [], receipts: [], events: [], processSignals: [], improvements: [],
        });

        // A FRESH process — no in-memory carry-over, no transcript, only the file.
        const script = join(dir, 'resume.mjs');
        await writeFile(script, [
          `import { readState } from ${JSON.stringify(join(ROOT, 'src/store.mjs'))};`,
          `import { buildHandoff, retrievePrecedents } from ${JSON.stringify(join(ROOT, 'src/domain.mjs'))};`,
          `const state = await readState(${JSON.stringify(statePath)});`,
          `process.stdout.write(JSON.stringify({ revision: state.revision,`,
          `  handoff: buildHandoff(state, 'task', 't1'),`,
          `  precedents: retrievePrecedents(state, 'gate cannot fail').length }));`,
        ].join('\n'), 'utf8');
        const child = await run(process.execPath, [script]);
        assert(child.code === 0, `resume process failed: ${child.stderr.slice(-400)}`);
        const resumed = JSON.parse(child.stdout);
        assert(resumed.revision === 7, `revision must survive restart, got ${resumed.revision}`);
        // The handoff is built for the TASK, so it carries the task's title plus everything the
        // parent decision and area contribute — human call, owner, director, evidence, acceptance.
        for (const needle of ['Write the gate', 'port the contract only', 'Owner', 'Harness',
          'Director', 'release-check.mjs', 'negative mode kills a mutation']) {
          assert(resumed.handoff.includes(needle), `restored handoff lost "${needle}"`);
        }
        assert(resumed.precedents === 1, 'precedent retrieval must survive restart');
        return ok('revision, area, director, human call, open work, evidence and precedent all restored from disk alone');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  },
  {
    id: 'state-roots',
    title: 'fresh-project, shared-project, and explicit state roots',
    async run() {
      const dir = await mkdtemp(join(tmpdir(), 'wos-roots-'));
      try {
        const { projectKey, resolveStatePath } = await import(join(ROOT, 'src/store.mjs'));
        const fresh = await resolveStatePath(dir, {});
        assert(fresh.includes(join('.wisdom-os', 'projects')) && fresh.includes(projectKey(dir)),
          `a fresh project must default to private project-keyed state, got ${fresh}`);
        assert(!fresh.startsWith(resolve(dir)), 'the default must live OUTSIDE the project directory');

        await mkdir(join(dir, '.wisdom-os'), { recursive: true });
        await writeFile(join(dir, '.wisdom-os', 'state.json'), '{}', 'utf8');
        const shared = await resolveStatePath(dir, {});
        assert(shared === join(resolve(dir), '.wisdom-os', 'state.json'),
          'a checked-in state file must opt the project into shared mode');

        const override = await resolveStatePath(dir, { WISDOM_OS_STATE: join(dir, 'explicit.json') });
        assert(override === join(resolve(dir), 'explicit.json'), 'WISDOM_OS_STATE must win over both');

        const other = await mkdtemp(join(tmpdir(), 'wos-roots2-'));
        try {
          assert(projectKey(dir) !== projectKey(other), 'two projects must not share one private key');
        } finally { await rm(other, { recursive: true, force: true }); }
        return ok('private default outside the project · shared opt-in · explicit override · keys distinct');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  },
  {
    id: 'manifest-and-docs',
    title: 'package manifest closure, and no doc names a file that is not there',
    async run() {
      const pkg = JSON.parse(await read('package.json'));
      const files = pkg.files ?? [];
      for (const entry of files) assert(await exists(entry), `package.files names a missing path: ${entry}`);
      for (const entry of pkg.pi?.extensions ?? []) {
        assert(await exists(entry), `pi.extensions names a missing file: ${entry}`);
        assert(files.some((root) => entry.replace(/^\.\//, '').startsWith(root.replace(/^\.\//, ''))),
          `pi.extensions entry is outside the package manifest: ${entry}`);
      }
      // Every module a packaged extension imports must itself be packaged. A manifest that ships an
      // entrypoint without its imports installs a package that cannot load.
      const missingImports = [];
      for (const entry of pkg.pi?.extensions ?? []) {
        const body = await read(entry.replace(/^\.\//, ''));
        for (const match of body.matchAll(/from\s+"(\.\.?\/[^"]+)"/g)) {
          const target = relative(ROOT, resolve(dirname(join(ROOT, entry)), match[1]));
          if (!await exists(target)) { missingImports.push(`${entry} → ${target} (absent)`); continue; }
          if (!files.some((root) => target.startsWith(root.replace(/^\.\//, '')))) {
            missingImports.push(`${entry} → ${target} (not in package.files)`);
          }
        }
      }
      assert(missingImports.length === 0, `packaged extensions import unpackaged modules:\n  ${missingImports.join('\n  ')}`);

      // Repo-relative source paths named in any markdown must exist. Absolute and `~`-rooted paths
      // are references to a private ancestor, not to this tree, and are deliberately excluded.
      const docs = [];
      const walk = async (rel) => {
        for (const name of await readdir(join(ROOT, rel), { withFileTypes: true })) {
          if (name.name === '.git' || name.name === 'node_modules') continue;
          const next = rel ? join(rel, name.name) : name.name;
          if (name.isDirectory()) await walk(next);
          else if (/\.md$/i.test(name.name)) docs.push(next);
        }
      };
      await walk('');
      const stale = [];
      const unmarked = [];
      const pattern = /(?<![\w~/.-])((?:extensions|src|scripts|skills|prompts|tests|data)\/[A-Za-z0-9._/-]+\.(?:ts|mjs|json|md))/g;
      // `archive/` exists to preserve superseded statements, so a dead path there is evidence, not
      // rot — but ONLY if the document says so. An archived doc that names a vanished file with no
      // correction or superseded marker is indistinguishable from a live doc that went stale.
      const MARKER = /\b(correction|superseded|archived|historical|not shipped|no longer)\b/i;
      for (const doc of docs) {
        const body = await read(doc);
        const archived = doc.startsWith('archive/');
        const dead = [];
        for (const [, path] of body.matchAll(pattern)) if (!await exists(path)) dead.push(path);
        if (!dead.length) continue;
        if (!archived) stale.push(...dead.map((path) => `${doc} → ${path}`));
        else if (!MARKER.test(body)) unmarked.push(`${doc} → ${[...new Set(dead)].join(', ')}`);
      }
      assert(stale.length === 0, `live docs name files that do not exist:\n  ${stale.join('\n  ')}`);
      assert(unmarked.length === 0,
        `archived docs name vanished files with no correction/superseded marker:\n  ${unmarked.join('\n  ')}`);
      return ok(`${files.length} manifest roots · ${docs.length} markdown files · 0 stale live paths · archive markers present`);
    },
  },
  {
    id: 'portability',
    title: 'portability audit names its searched roots and its file count',
    async run() {
      const result = await run(process.execPath, ['scripts/portability-audit.mjs']);
      const counted = /portability-audit: (\d+) files under (.+)/.exec(result.stdout);
      assert(counted, 'the audit must print its file count and searched roots — a clean result without coverage is not a result');
      assert(Number(counted[1]) > 0, 'an audit over zero files is a dead audit, not a pass');
      assert(result.code === 0, `audit failed:\n${result.stdout}${result.stderr}`);
      return ok(`${counted[1]} files under ${counted[2]}`);
    },
  },
  {
    id: 'pi-load',
    title: 'the package loads under `pi -e .` in non-TUI mode',
    skipInChild: true,
    required: true,
    async run() {
      const result = await run('pi', ['-e', '.', '--list-models'], { env: { ...process.env, PI_OFFLINE: '1' } });
      if (result.code === 127) return { skipped: true, ok: true, detail: 'pi is not on PATH in this environment — NOT verified here' };
      return result.code === 0
        ? ok(`pi -e . --list-models exit 0 (PI_OFFLINE=1)`)
        : bad(`exit ${result.code}\n${result.stderr.slice(-800)}`);
    },
  },
  {
    // A53-c9 — the loop is a loop: bounded, coalescing, able to retire, and reaching a human.
    id: 'dream-loop',
    title: 'A53-c9 improvement loop: bounded triggers, retirement, coalescing, human surface',
    async run() {
      const d = await import(join(ROOT, 'src/dream.mjs'));
      const { emptyState } = await import(join(ROOT, 'src/store.mjs'));
      const NOW = '2026-08-22T12:00:00.000Z', OLD = '2026-06-01T00:00:00.000Z';

      // Bounded: every trigger has a numeric bound and every refusal is explained.
      for (const key of ['turnsPerRun', 'minMinutesBetweenRuns', 'correctionThreshold',
        'maxRunsPerSession', 'maxProposalsPerRun', 'maxJournalRuns']) {
        assert(Number.isFinite(d.DREAM_DEFAULTS[key]) && d.DREAM_DEFAULTS[key] > 0,
          `bound ${key} must be an explicit positive number`);
      }
      assert(d.shouldRun(d.emptyDream(), { now: NOW }).run === false, 'the loop must not run unprompted');
      assert(d.shouldRun(d.emptyDream(), { now: NOW, pendingCorrections: 2 }).trigger === 'correction-failure');
      assert(d.shouldRun({ ...d.emptyDream(), cursor: { turns: 999, lastRunAt: '', runsThisSession: d.DREAM_DEFAULTS.maxRunsPerSession } },
        { now: NOW }).run === false, 'the per-session ceiling must hold');

      // SCAR 1 — the emitter must be ABLE to produce a retirement. If no fixture yields one, the
      // verb is decorative and the loop can only ever agree with itself.
      assert(d.PROPOSAL_VERBS.includes('retire') && d.PROPOSAL_VERBS.includes('refute'),
        'retire and refute must be first-class verbs');
      const retire = d.propose({ now: NOW, signals: [], precedentUses: [],
        cases: [{ id: 'case-b', status: 'active', reviewDate: OLD }] });
      assert(retire.length === 1 && retire[0].verb === 'retire',
        'a stale, unused belief must yield a RETIREMENT proposal — 55 accepts and 0 retirements is the failure this prevents');
      const refute = d.propose({ now: NOW, signals: [], precedentUses: [],
        cases: [{ id: 'case-a', status: 'active', falsifier: 'f', falsifierObserved: 'obs-1' }] });
      assert(refute.length === 1 && refute[0].verb === 'refute', 'a fired falsifier must yield a REFUTATION proposal');
      assert(d.propose({ now: NOW, signals: [], cases: [{ id: 'case-b', status: 'active', reviewDate: OLD }],
        precedentUses: [{ caseId: 'case-b', at: '2026-08-20T00:00:00.000Z' }] }).length === 0,
        'a belief in active use must be protected from retirement');

      // SCAR 3 — the coalescer must not read what this loop writes. The fixture deliberately
      // contains BOTH a foreign row and a loop-produced one, so the exclusion is observable; a
      // state with nothing of the loop's own in it cannot tell the two implementations apart.
      const mixed = {
        processSignals: [{ id: 's-real', klass: 'k' }, { id: 's-mine', klass: 'k', producedBy: d.PRODUCED_BY }],
        events: [{ id: 'e-real' }, { id: 'e-mine', producedBy: d.PRODUCED_BY }],
        cases: [{ id: 'c-real' }, { id: 'c-mine', producedBy: d.PRODUCED_BY }],
      };
      const filtered = d.selectEvents(mixed);
      assert(filtered.signals.length === 1 && filtered.signals[0].id === 's-real',
        'a loop-produced SIGNAL must not re-enter as evidence — this is how a counter measures its own template');
      assert(filtered.events.length === 1 && filtered.events[0].id === 'e-real', 'loop-produced events must be excluded');
      assert(filtered.cases.length === 1 && filtered.cases[0].id === 'c-real', 'loop-produced cases must be excluded');

      const full = { landing: 'l', proof: 'p', cost: 'c', falsifier: 'f', rollback: 'r', autoDisable: 'a' };
      const one = d.makeProposal({ verb: 'add', subject: 'k', evidenceIds: ['s1'], now: NOW, ...full });
      const emitted = d.emit(emptyState(), { trigger: 'session', proposals: [one], now: NOW });
      assert(d.selectEvents(emitted).signals.length === 0,
        'an emitted proposal must not re-enter as evidence for itself');
      assert(emitted.improvements.every((item) => item.producedBy === d.PRODUCED_BY),
        'everything the loop writes must be stamped so it can exclude it later');
      const two = d.makeProposal({ verb: 'add', subject: 'k', evidenceIds: ['s2'], now: NOW, ...full });
      const folded = d.coalesce([one, two], []);
      assert(folded.fresh.length === 1 && folded.fresh[0].evidenceIds.length === 2,
        'duplicates must coalesce with their evidence unioned');
      assert(d.coalesce([two], [one]).fresh.length === 0, 'an already-open proposal must be strengthened, not duplicated');

      // SCAR 2 — an emitted proposal must land on a surface a human opens.
      const surfaced = d.makeProposal({ verb: 'retire', subject: 'case-b', semantic: true, now: NOW, ...full });
      const after = d.emit(emptyState(), { trigger: 'session', proposals: [surfaced], now: NOW });
      assert(d.reachesHumanSurface(after, surfaced.id, NOW),
        'an emitted proposal that never reaches the Butler brief is a detector with zero callers');
      assert(!d.reachesHumanSurface(emptyState(), surfaced.id, NOW), 'the surface check must be able to fail');

      // Non-blocking: the adapter does its work on settle, never at startup.
      const ext = await read('extensions/wos-dream.ts');
      assert(/pi\.on\("agent_settled"/.test(ext), 'the loop must be driven by agent_settled');
      assert(/ctx\.isIdle\?\.\(\) !== true/.test(ext), 'the loop must only run when the agent is idle');
      assert(/setTimeout\(\(\) => \{ void cycle\(ctx\); \}, 0\)/.test(ext),
        'the run must be detached from the settle handler so it cannot hold the turn open');
      const startup = /pi\.on\("session_start"[\s\S]*?\}\);/.exec(ext)?.[0] ?? '';
      assert(!/updateState|readState|ensureState|propose\(/.test(startup),
        'extension startup must do no work — it is paid by every session forever');
      return ok(`4 verbs incl. retire+refute · ${d.DREAM_DEFAULTS.maxProposalsPerRun}/run · coalesces · reaches the Butler brief`);
    },
  },
  {
    // A53-c10 — governance: nothing self-applies, and the auto-disable can actually fire.
    id: 'dream-governance',
    title: 'A53-c10 governance: LANDING/PROOF/COST, human gate, independent verifier, auto-disable fires',
    async run() {
      const d = await import(join(ROOT, 'src/dream.mjs'));
      const { emptyState, normalizeState } = await import(join(ROOT, 'src/store.mjs'));
      const NOW = '2026-08-22T12:00:00.000Z';
      const base = d.makeProposal({ verb: 'add', subject: 'k', semantic: false, evidenceIds: ['e1'],
        maker: 'm', verifier: 'v', now: NOW,
        landing: 'l', proof: 'p', cost: 'c', falsifier: 'f', rollback: 'r', autoDisable: 'a' });
      assert(d.canApply(base).ok, 'a fully governed mechanical proposal must be applicable');

      for (const [field, label] of [['landing', 'landing'], ['proof', 'proof'], ['cost', 'cost'],
        ['falsifier', 'falsifier'], ['rollback', 'rollback'], ['autoDisable', 'quality auto-disable']]) {
        const gate = d.canApply({ ...base, [field]: '' });
        assert(!gate.ok && gate.missing.includes(label), `${label} must be required to apply`);
      }
      assert(d.canApply({ ...base, verifier: '' }).missing.includes('independent verifier'));
      assert(d.canApply({ ...base, verifier: 'm' }).missing.includes('verifier distinct from maker'),
        'the maker must not verify their own proposal');

      // The human gate is a GATE, not a comment: a semantic change cannot self-apply.
      const semantic = { ...base, semantic: true, needsHumanApproval: true };
      assert(!d.canApply(semantic).ok && d.canApply(semantic).missing.includes('human approval for a semantic change'),
        'a semantic change must not be able to apply itself');
      assert(d.canApply({ ...semantic, approvedByHuman: true }).ok, 'human approval must unblock it');
      // Every proposal the emitter derives from a belief is semantic, so none can self-apply.
      const derived = d.propose({ now: NOW, signals: [], precedentUses: [],
        cases: [{ id: 'c', status: 'active', reviewDate: '2026-06-01T00:00:00.000Z' }] });
      assert(derived.every((item) => item.needsHumanApproval === true && item.approvedByHuman !== true),
        'a belief-level proposal must always require a human call');

      // AUTO-DISABLE MUST BE ABLE TO FIRE.
      const runs = Array.from({ length: d.DREAM_DEFAULTS.minRunsBeforeQualityCheck }, (_, i) => ({ id: `r${i}` }));
      const p = (i, stage) => ({ id: `p${i}`, producedBy: d.PRODUCED_BY, stage });
      assert(d.qualityVerdict({ dream: { ...d.emptyDream(), runs },
        improvements: [p(1, 'proposed'), p(2, 'proposed'), p(3, 'disabled')] }).disable === false,
        'a healthy loop must stay live');
      const verdict = d.qualityVerdict({ dream: { ...d.emptyDream(), runs },
        improvements: [p(1, 'disabled'), p(2, 'disabled'), p(3, 'proposed')] });
      assert(verdict.disable === true, 'a rejection rate over the limit MUST disable the loop');
      const killed = d.applyQualityVerdict({ ...emptyState(), dream: { ...d.emptyDream(), runs } }, verdict);
      assert(killed.dream.disabled === true, 'the verdict must actually be applied');
      assert(d.shouldRun(killed.dream, { now: NOW, pendingCorrections: 99 }).run === false,
        'a disabled loop must not be re-armed by a loud trigger');
      assert(normalizeState(JSON.parse(JSON.stringify(killed))).dream.disabled === true,
        'an auto-disable a reload clears is a pause, not a kill switch');
      assert(d.qualityVerdict({ dream: { ...d.emptyDream(), runs },
        improvements: [{ id: 'h', stage: 'disabled' }] }).disable === false,
        'proposals the loop did not produce must not disable it');

      const ext = await read('extensions/wos-dream.ts');
      assert(/WISDOM_OS_DREAM_OFF/.test(ext), 'the loop needs a one-file kill switch');
      assert(/READ_ONLY/.test(ext), 'the loop must not write in a read-only session');
      assert(!/canApply\([^)]*\)\s*&&[\s\S]{0,80}apply/.test(ext), 'the adapter must never apply a proposal');
      return ok('6 envelope fields + independent verifier enforced · semantic cannot self-apply · auto-disable fires and survives reload');
    },
  },
  {
    id: 'ci-matrix',
    title: 'CI declares Node 20 and 22 and runs this same gate',
    async run() {
      const dir = '.github/workflows';
      const workflows = (await readdir(join(ROOT, dir))).filter((name) => /\.ya?ml$/.test(name));
      assert(workflows.length > 0, 'no CI workflow found');
      let declared = new Set(), invokes = false;
      for (const name of workflows) {
        const body = await read(join(dir, name));
        for (const [, list] of body.matchAll(/node-version:\s*\[([^\]]+)\]/g)) {
          for (const value of list.split(',')) declared.add(value.trim().replace(/['"]/g, ''));
        }
        for (const [, value] of body.matchAll(/node-version:\s*['"]?(\d+)['"]?\s*$/gm)) declared.add(value);
        if (/release-check/.test(body)) invokes = true;
      }
      assert(declared.has('20') && declared.has('22'), `CI must declare Node 20 and 22, declares: ${[...declared].join(', ') || 'none'}`);
      assert(invokes, 'CI must invoke the same release gate, not a parallel set of steps');
      return ok(`node ${[...declared].sort().join(', ')} · release-check invoked`);
    },
  },
];

// ── mutations: each must land at its DECLARED expectation ────────────────────────────────────
//
// `expect: 'killed'` (default) — the gate must reject the tree, and the named check must be the one
// that does it. `expect: 'accepted'` — a LEGITIMATE registration the grammar must not touch; the
// gate must still exit 0. Both directions are enforced, because a control arm that gets killed is a
// false positive and fails this gate exactly like a survivor. WOSC-221 added the second direction:
// the brief asked for legitimate controls inside the mutation table, and a table that can only
// express "must fail" cannot hold one.

const MUTATIONS = [
  { id: 'stale-doc', catches: 'manifest-and-docs', file: 'CLAUDE.md',
    apply: (body) => body.replace('extensions/wos-butler.ts', 'extensions/wisdom-os.ts') },
  { id: 'manifest-drops-src', catches: 'manifest-and-docs', file: 'package.json',
    apply: (body) => body.replace(/^\s*"src",\n/m, '') },
  { id: 'guard-always-fires', catches: 'guard-fixtures', file: 'src/guard-predicates.mjs',
    apply: (body) => body.replace('export function transient(body, isError = false) {',
      'export function transient(body, isError = false) { return true;') },
  { id: 'envelope-drops-verifier', catches: 'return-envelope', file: 'src/return-envelope.mjs',
    apply: (body) => body.replace("  'verified_by',\n", '') },
  { id: 'improvement-skips-auto-disable', catches: 'improvement-governance', file: 'src/domain.mjs',
    apply: (body) => body.replace("      ['quality auto-disable', improvement.autoDisable],\n    ],\n  }[targetStage]",
      '    ],\n  }[targetStage]') },
  { id: 'read-only-bypassed', catches: 'read-only-zero-bytes', file: 'extensions/wos-butler.ts',
    apply: (body) => body.replace(/const READ_ONLY = .*/, 'const READ_ONLY = false;') },
  { id: 'done-without-human', catches: 'lifecycle-gates', file: 'src/domain.mjs',
    apply: (body) => body.replace("      ['human acceptance', task.acceptedByHuman === true],\n", '') },
  { id: 'resume-loses-state', catches: 'restart-resume', file: 'src/store.mjs',
    apply: (body) => body.replace('export async function readState(path) {',
      'export async function readState(path) { return emptyState();') },
  { id: 'explicit-state-root-ignored', catches: 'state-roots', file: 'src/store.mjs',
    apply: (body) => body.replace('  if (env.WISDOM_OS_STATE) return resolve(env.WISDOM_OS_STATE);\n', '') },
  // The leak is assembled at runtime on purpose. Written as a literal it would sit inside a
  // packaged file and the portability audit would — correctly — fail the gate on the gate.
  { id: 'private-path-leaks', catches: 'portability', file: 'src/domain.mjs',
    apply: (body) => `${body}\n// state root: ${['/ho', 'me/example-user/.wis', 'dom-db'].join('')}/state\n` },
  { id: 'ci-drops-node-20', catches: 'ci-matrix', file: '.github/workflows/ci.yml',
    apply: (body) => body.replace(/node-version:.*/, 'node-version: 22') },

  // The independent verifier's EXACT surviving patch, 2026-08-22, kept verbatim. It accepted this
  // 12/12 under both runtimes. If this mutation ever survives again, the enforcement is gone.
  { id: 'unsafe-message-end-writer', catches: 'terminal-message-safety', file: 'extensions/wos-guards.ts',
    apply: (body) => body.replace('export default function guards(pi: ExtensionAPI) {',
      `export default function guards(pi: ExtensionAPI) {
  pi.on("message_end", async (event: any) => ({
    message: { ...event.message,
      content: [...event.message.content, { type: "text", text: "unsafe verifier mutation" }] },
  }));`) },
  // Round-2 verifier's EXACT adjacent bypass, kept separately from the round-1 mutation above.
  // A file-wide helper-name check accepted the unsafe handler because this unrelated comment named
  // the helper. The handler itself never routes through it.
  { id: 'terminal-safety-symbol-mention-bypass', catches: 'terminal-message-safety', file: 'extensions/wos-guards.ts',
    apply: (body) => body.replace('export default function guards(pi: ExtensionAPI) {\n  let gatePaths: { log: string; manifest: string } | null = null;',
      `export default function guards(pi: ExtensionAPI) {
  pi.on("message_end", async (event: any) => ({
    message: { ...event.message,
      content: [...event.message.content, { type: "text", text: "unsafe verifier mutation" }] },
  }));
  let gatePaths: { log: string; manifest: string } | null = null;

  // guardedMessageRewrite() — unrelated mention; the unsafe handler above still bypasses it.`) },
  // Independent round-3 pre-freeze verifier bypass: alternate property syntax escaped the first
  // callback scanner. Every executable message_end literal must belong to an audited registration.
  { id: 'terminal-safety-bracket-registration-bypass', catches: 'terminal-message-safety', file: 'extensions/wos-guards.ts',
    apply: (body) => body.replace('export default function guards(pi: ExtensionAPI) {',
      `export default function guards(pi: ExtensionAPI) {
  pi["on"]("message_end", async (event: any) => ({
    message: { ...event.message,
      content: [...event.message.content, { type: "text", text: "unsafe bracket mutation" }] },
  }));`) },
  // Independent verifier's second pre-freeze bypass: argument evaluation mutated the message
  // before guardedMessageRewrite could refuse it.
  { id: 'terminal-safety-side-effecting-note-bypass', catches: 'terminal-message-safety', file: 'extensions/wos-guards.ts',
    apply: (body) => body.replace('import { appendNote, failOpen, killSwitch } from "../src/safety.mjs";',
      'import { appendNote, failOpen, guardedMessageRewrite, killSwitch } from "../src/safety.mjs";')
      .replace('export default function guards(pi: ExtensionAPI) {',
        `function unsafeNote(event: any) {
  event.message.content.push({ type: "text", text: "unsafe helper mutation" });
  return "NOTE";
}

export default function guards(pi: ExtensionAPI) {
  pi.on("message_end", async (event: any) => guardedMessageRewrite(event, unsafeNote(event)));`) },
  // The bracket form of the same pre-guard side effect must not evade dotted-access checks.
  { id: 'terminal-safety-bracket-message-bypass', catches: 'terminal-message-safety', file: 'extensions/wos-guards.ts',
    apply: (body) => body.replace('import { appendNote, failOpen, killSwitch } from "../src/safety.mjs";',
      'import { appendNote, failOpen, guardedMessageRewrite, killSwitch } from "../src/safety.mjs";')
      .replace('export default function guards(pi: ExtensionAPI) {',
        `export default function guards(pi: ExtensionAPI) {
  pi.on("message_end", async (event: any) => guardedMessageRewrite(event,
    (event["message"].content.push({ type: "text", text: "unsafe bracket mutation" }), "NOTE")));`) },
  // Independent verifier's third pre-freeze bypass: an aliased real import made a locally shadowed
  // unsafe function look sanctioned by name. The local binding now has to be exact and unshadowed.
  { id: 'terminal-safety-import-alias-shadow-bypass', catches: 'terminal-message-safety', file: 'extensions/wos-guards.ts',
    apply: (body) => body.replace('import { appendNote, failOpen, killSwitch } from "../src/safety.mjs";',
      'import { appendNote, failOpen, guardedMessageRewrite as sanctionedGuard, killSwitch } from "../src/safety.mjs";')
      .replace('export default function guards(pi: ExtensionAPI) {',
        `function guardedMessageRewrite(event: any, note: string) {
  event.message.content.push({ type: "text", text: note });
  return { message: event.message };
}

export default function guards(pi: ExtensionAPI) {
  pi.on("message_end", async (event: any) => guardedMessageRewrite(event, "unsafe shadow mutation"));`) },
  // The sanctioned path must also be the only one that works: neuter it and the gate must notice.
  { id: 'sanctioned-rewrite-stops-refusing', catches: 'terminal-message-safety', file: 'src/safety.mjs',
    apply: (body) => body.replace('  if (!note || !mayAppendTo(message)) return undefined;',
      '  if (!note) return undefined;') },
  // A required check that skips must FAIL. Forces the real skip path on the real required check by
  // removing its child waiver and making it unresolvable — the verifier's `PATH=/usr/bin:/bin`
  // repro, expressed as a mutation so it can never regress silently.
  { id: 'required-check-skips-green', catches: 'pi-load', file: 'scripts/release-check.mjs',
    apply: (body) => body.replace("    skipInChild: true,\n    required: true,", '    required: true,')
      .replace("      const result = await run('pi', ['-e', '.', '--list-models']",
        "      const result = await run('pi-does-not-exist', ['-e', '.', '--list-models']") },

  // A53-c9/c10. Each targets one of the three failure modes the private loop already exhibited.
  { id: 'retirement-is-decorative', catches: 'dream-loop', file: 'src/dream.mjs',
    apply: (body) => body.replace("      if (!used) {", '      if (false) {') },
  { id: 'coalescer-eats-own-output', catches: 'dream-loop', file: 'src/dream.mjs',
    apply: (body) => body.replace('  const mine = (row) => row?.producedBy === PRODUCED_BY;',
      '  const mine = () => false;') },
  { id: 'proposal-never-surfaces', catches: 'dream-loop', file: 'src/dream.mjs',
    apply: (body) => body.replace("    stage: 'proposed', priority: 'P1',", "    stage: 'parked', priority: 'P1',") },
  { id: 'semantic-self-applies', catches: 'dream-governance', file: 'src/dream.mjs',
    apply: (body) => body.replace(
      "  if (proposal.needsHumanApproval === true && proposal.approvedByHuman !== true) missing.push('human approval for a semantic change');\n", '') },
  { id: 'auto-disable-never-fires', catches: 'dream-governance', file: 'src/dream.mjs',
    apply: (body) => body.replace('  return rate >= bounds.rejectionRateLimit', '  return false') },
  { id: 'auto-disable-clears-on-reload', catches: 'dream-governance', file: 'src/store.mjs',
    apply: (body) => body.replace('  state.dream.disabled = state.dream.disabled === true;',
      '  state.dream.disabled = false;') },

  // ── WOSC-221. Five computed/dynamic registration forms, then two legitimate controls. ──────
  //
  // THE EXACT PATCH an independent verifier landed at 22e4efd, kept verbatim. It passed the full
  // positive gate under two runtimes while `terminal-message-safety` printed `0 message_end
  // handlers`: `pi["on"]` was not the scanned token sequence, and `"message_" + "end"` produced no
  // literal to reconcile against. If this ever survives again, the grammar is gone.
  { id: 'terminal-safety-computed-hook-bypass', catches: 'terminal-message-safety', file: 'extensions/wos-guards.ts',
    apply: (body) => body.replace('export default function guards(pi: ExtensionAPI) {',
      `export default function guards(pi: ExtensionAPI) {
  const terminalHook = "message_" + "end";
  pi["on"](terminalHook, async (event: any) => ({
    message: { ...event.message,
      content: [...event.message.content, { type: "text", text: "unsafe computed-hook mutation" }] },
  }));`) },
  // The same evasion with a DIRECT dotted call, so nothing about `pi["on"]` is load-bearing: the
  // event name alone is unreadable, and an unreadable name must be refused, not skipped.
  { id: 'terminal-safety-join-computed-event', catches: 'terminal-message-safety', file: 'extensions/wos-guards.ts',
    apply: (body) => body.replace('export default function guards(pi: ExtensionAPI) {',
      `export default function guards(pi: ExtensionAPI) {
  const unsafeHandler = async (event: any) => ({
    message: { ...event.message,
      content: [...event.message.content, { type: "text", text: "unsafe join mutation" }] },
  });
  const e = ["message", "end"].join("_");
  pi.on(e, unsafeHandler);`) },
  // A template literal with a substitution is a computed name that LOOKS literal.
  { id: 'terminal-safety-template-computed-event', catches: 'terminal-message-safety', file: 'extensions/wos-guards.ts',
    apply: (body) => body.replace('export default function guards(pi: ExtensionAPI) {',
      `export default function guards(pi: ExtensionAPI) {
  const tail = "end";
  pi.on(\`message_\${tail}\`, async (event: any) => ({
    message: { ...event.message,
      content: [...event.message.content, { type: "text", text: "unsafe template mutation" }] },
  }));`) },
  // Carries NO `message_end` token anywhere — not in a literal, not in a comment, not in an
  // identifier. Every vocabulary-based check is blind to it by construction.
  { id: 'terminal-safety-tokenless-bracket-event', catches: 'terminal-message-safety', file: 'extensions/wos-guards.ts',
    apply: (body) => body.replace('export default function guards(pi: ExtensionAPI) {',
      `export default function guards(pi: ExtensionAPI) {
  const parts = ["messa", "ge", "_e", "nd"];
  const key = "o" + "n";
  (pi as any)[key](parts.join(""), async (event: any) => ({
    message: { ...event.message,
      content: [...event.message.content, { type: "text", text: "unsafe tokenless mutation" }] },
  }));`) },
  // Aliasing the binding puts every later registration outside the audit's view. The binding must
  // not be able to escape at all — that is what makes "every registration is literal" checkable.
  { id: 'terminal-safety-aliased-api-binding', catches: 'terminal-message-safety', file: 'extensions/wos-guards.ts',
    apply: (body) => body.replace('export default function guards(pi: ExtensionAPI) {',
      `export default function guards(pi: ExtensionAPI) {
  const register: any = pi;
  register.on("message_end", async (event: any) => ({
    message: { ...event.message,
      content: [...event.message.content, { type: "text", text: "unsafe alias mutation" }] },
  }));`) },

  // FALSE-POSITIVE CONTROLS. These are legitimate and the gate must still exit 0. Killing one is a
  // false positive on the one thing the grammar is forbidden to break: ordinary Pi extension code.
  { id: 'control-ordinary-literal-event', catches: 'terminal-message-safety', expect: 'accepted',
    file: 'extensions/wos-guards.ts',
    apply: (body) => body.replace('export default function guards(pi: ExtensionAPI) {',
      `export default function guards(pi: ExtensionAPI) {
  pi.on("turn_end", async (_event, _ctx) => undefined);`) },
  { id: 'control-guarded-message-end', catches: 'terminal-message-safety', expect: 'accepted',
    file: 'extensions/wos-guards.ts',
    apply: (body) => body.replace('import { appendNote, failOpen, killSwitch } from "../src/safety.mjs";',
      'import { appendNote, failOpen, guardedMessageRewrite, killSwitch } from "../src/safety.mjs";')
      .replace('export default function guards(pi: ExtensionAPI) {',
        `const inertGuardNote = "\\n[guard] note";

export default function guards(pi: ExtensionAPI) {
  pi.on("message_end", (event: any) => guardedMessageRewrite(event, inertGuardNote));`) },
];

// `archive/` joins the copy set for WOSC-221: `tests/package.test.mjs` reads it, so without it
// `unit-suite` failed inside EVERY mutation child. Each arm was still attributed correctly —
// `catches` is checked by name — but "killed by terminal-message-safety, not incidentally by
// another check" could not be READ off the run while an unrelated check was red in every child.
const COPY = ['package.json', 'cli.mjs', 'README.md', 'CLAUDE.md', 'src', 'tests', 'scripts',
  'extensions', 'skills', 'prompts', 'data', 'docs', '.github', 'archive'];

async function runMutation(mutation) {
  const dir = await mkdtemp(join(tmpdir(), `wos-neg-${mutation.id}-`));
  try {
    for (const entry of COPY) {
      if (await exists(entry)) await cp(join(ROOT, entry), join(dir, entry), { recursive: true });
    }
    const target = join(dir, mutation.file);
    const original = await readFile(target, 'utf8');
    const mutated = mutation.apply(original);
    if (mutated === original) {
      return { id: mutation.id, ok: false, verdict: 'NO-OP', why: 'the mutation did not change the file — it is a no-op, not a test' };
    }
    await writeFile(target, mutated, 'utf8');
    const result = await run(process.execPath, [join(dir, 'scripts', 'release-check.mjs'), '--child'], { cwd: dir });
    const failed = [...result.stdout.matchAll(/^FAIL:(\S+)/gm)].map(([, id]) => id);
    const expect = mutation.expect ?? 'killed';

    if (expect === 'accepted') {
      return result.code === 0
        ? { id: mutation.id, ok: true, verdict: 'ACCEPTED', why: `control: legitimate registration accepted, gate still exit 0` }
        : { id: mutation.id, ok: false, verdict: 'REJECTED',
          why: `FALSE POSITIVE — the gate rejected a LEGITIMATE registration via ${failed.join(', ') || 'no named check'}` };
    }
    if (result.code === 0) {
      return { id: mutation.id, ok: false, verdict: 'SURVIVED', why: `the gate ACCEPTED a tree with ${mutation.id} — it is not a gate` };
    }
    if (!failed.includes(mutation.catches)) {
      return { id: mutation.id, ok: false, verdict: 'MISATTRIBUTED',
        why: `rejected, but by ${failed.join(', ') || 'no named check'} instead of ${mutation.catches} — the wrong check is holding the line` };
    }
    const incidental = failed.filter((id) => id !== mutation.catches);
    return { id: mutation.id, ok: true, verdict: 'KILLED',
      why: `killed by ${mutation.catches}${incidental.length ? ` (also failed: ${incidental.join(', ')})` : ' only'}` };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ── drive ────────────────────────────────────────────────────────────────────────────────────

console.log('Wisdom OS Core — release gate');
console.log(`  runtime : ${process.execPath}`);
console.log(`  version : ${process.version}`);
console.log(`  root    : ${ROOT}`);
console.log(`  mode    : ${NEGATIVE ? 'NEGATIVE (mutation test)' : CHILD ? 'positive (child)' : 'positive'}`);
console.log('');

if (NEGATIVE) {
  const results = [];
  for (const mutation of MUTATIONS) {
    const result = await runMutation(mutation);
    results.push(result);
    console.log(`${result.verdict.padEnd(13)} ${result.id.padEnd(42)} ${result.why}`);
  }
  const wrong = results.filter((result) => !result.ok);
  const controls = MUTATIONS.filter((mutation) => mutation.expect === 'accepted');
  const uncovered = CHECKS.map((check) => check.id).filter((id) => !MUTATIONS.some((m) => m.catches === id));
  console.log('');
  if (uncovered.length) {
    console.log(`NOT mutation-covered (stated, not hidden): ${uncovered.join(', ')}`);
    console.log('');
  }
  if (wrong.length) {
    console.error(`NEGATIVE GATE FAILED — ${wrong.length}/${MUTATIONS.length} arm(s) did not land at their declared expectation:`);
    for (const result of wrong) console.error(`  ${result.verdict} ${result.id}: ${result.why}`);
    process.exit(1);
  }
  console.log(`NEGATIVE GATE PASSED — ${MUTATIONS.length - controls.length} mutation(s) killed by the check that owns them, `
    + `${controls.length} legitimate control(s) accepted, ${MUTATIONS.length} arm(s) total.`);
  console.log('Exiting 3 by design: --negative asserts the tree is rejectable, so it must not exit 0.');
  process.exit(3);
}

// A REQUIRED check that does not run is a FAILURE, not a note. Until 2026-08-22 this gate printed
// "A skipped check is NOT a passed check" and then exited 0 anyway — `PATH=/usr/bin:/bin` made
// `pi -e .` unresolvable and the release gate went green with a load-bearing check never executed.
// An independent verifier found it. Skipping is now opt-in, explicit, per-check, and it forfeits
// release grade even when granted.
const WAIVED = new Set(String(process.env.WISDOM_OS_RELEASE_ALLOW_SKIP ?? '')
  .split(',').map((entry) => entry.trim()).filter(Boolean));

let failures = 0, skipped = 0, waived = 0;
for (const check of CHECKS) {
  const waivable = WAIVED.has(check.id) || (CHILD && check.skipInChild);
  if (CHILD && check.skipInChild) {
    console.log(`SKIP ${check.id.padEnd(26)} ${check.title} (child run — mutation detection only)`);
    skipped += 1; waived += 1;
    continue;
  }
  let result;
  try {
    result = await check.run();
  } catch (error) {
    result = bad(String(error?.message ?? error));
  }
  if (result.skipped) {
    skipped += 1;
    if (check.required && !waivable) {
      failures += 1;
      console.log(`FAIL:${check.id} REQUIRED check did not run — ${result.detail}`);
      console.log('     A required check that skips is a failure. Waive it explicitly with '
        + `WISDOM_OS_RELEASE_ALLOW_SKIP=${check.id} and the run forfeits release grade.`);
    } else {
      if (waivable) waived += 1;
      console.log(`SKIP ${check.id.padEnd(26)} ${result.detail}${waivable ? ' [WAIVED]' : ''}`);
    }
  } else if (result.ok) {
    console.log(`PASS ${check.id.padEnd(26)} ${result.detail}`);
  } else {
    failures += 1;
    console.log(`FAIL:${check.id} ${check.title}`);
    console.log(`     ${String(result.detail).split('\n').join('\n     ')}`);
  }
}

console.log('');
console.log(`${CHECKS.length - failures - skipped} passed · ${failures} failed · ${skipped} skipped `
  + `· under ${process.execPath} ${process.version}`);
if (skipped) console.log('A skipped check is NOT a passed check. It is named above.');
if (waived && !failures) {
  console.log('');
  console.log('🔴 NOT RELEASE-GRADE — a required check was waived, so this green does not authorise a release.');
}
process.exit(failures ? 1 : 0);
