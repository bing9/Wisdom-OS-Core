/**
 * The registration grammar for packaged Pi extensions — WOSC-221.
 *
 * WHY THIS MODULE EXISTS
 *
 * The previous gate audited `message_end` by looking for the token sequence `pi . on (` and then
 * reconciling against executable `"message_end"` string literals. Both halves read VOCABULARY. A
 * registration written as
 *
 *     const terminalHook = "message_" + "end";
 *     pi["on"](terminalHook, unsafeHandler);
 *
 * has neither token, so the audit reported `0 message_end handlers` and the gate went green with an
 * unconditional assistant-message rewriter installed. An unreadable registration was treated as no
 * registration. That is the defect: SILENCE ON THE UNREADABLE.
 *
 * THE RULE, inverted: a registration this scanner cannot read is REJECTED, never skipped.
 *
 * Pi documents exactly one registration form — `pi.on("event_name", handler)` — in every example in
 * `extensions.md`, and states that a `message_end` handler may replace the finalized message but
 * must keep the same `role`. Packaged extensions are therefore held to the documented form, so that
 * an event name is always a value this scanner can read at audit time and event-specific policy can
 * never be evaded by making the name unreadable.
 *
 * SCOPE AND HONESTY ABOUT THE METHOD
 *
 * This is a LEXICAL scanner, not a JavaScript parser, and deliberately so: a parser is a dependency
 * and a half-written parser is worse than none. Every rule below is conservative — it rejects more
 * than it must and never fewer. A legitimate form that trips it is a code-review conversation with
 * a named rule id, not a silent block. `findings()` is the whole contract; the gate and the
 * standalone scanner both call it, so the enforcement cannot drift from the claim.
 */

/**
 * Blank out comments (always) and string bodies (optionally) while keeping every index stable, so
 * offsets found in the mask address the same characters in the source.
 */
export function lexicalMask(source, maskStrings = true) {
  const out = [...source];
  let state = 'code';
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i], next = source[i + 1];
    if (state === 'line-comment') {
      if (char === '\n') state = 'code';
      else out[i] = ' ';
    } else if (state === 'block-comment') {
      out[i] = char === '\n' ? '\n' : ' ';
      if (char === '*' && next === '/') { out[i + 1] = ' '; i += 1; state = 'code'; }
    } else if (state === 'single' || state === 'double' || state === 'template') {
      if (maskStrings) out[i] = char === '\n' ? '\n' : ' ';
      if (char === '\\') {
        if (maskStrings && i + 1 < source.length) out[i + 1] = source[i + 1] === '\n' ? '\n' : ' ';
        i += 1;
      } else if ((state === 'single' && char === "'") || (state === 'double' && char === '"')
        || (state === 'template' && char === '`')) state = 'code';
    } else if (char === '/' && next === '/') {
      out[i] = out[i + 1] = ' '; i += 1; state = 'line-comment';
    } else if (char === '/' && next === '*') {
      out[i] = out[i + 1] = ' '; i += 1; state = 'block-comment';
    } else if (char === "'") {
      if (maskStrings) out[i] = ' ';
      state = 'single';
    } else if (char === '"') {
      if (maskStrings) out[i] = ' ';
      state = 'double';
    } else if (char === '`') {
      if (maskStrings) out[i] = ' ';
      state = 'template';
    }
  }
  return out.join('');
}

export function matchingParen(masked, openAt) {
  let depth = 0;
  for (let i = openAt; i < masked.length; i += 1) {
    if (masked[i] === '(') depth += 1;
    else if (masked[i] === ')' && --depth === 0) return i;
  }
  return -1;
}

export function splitTopLevel(source) {
  const masked = lexicalMask(source);
  const parts = [];
  let start = 0, round = 0, square = 0, curly = 0;
  for (let i = 0; i < masked.length; i += 1) {
    if (masked[i] === '(') round += 1;
    else if (masked[i] === ')') round -= 1;
    else if (masked[i] === '[') square += 1;
    else if (masked[i] === ']') square -= 1;
    else if (masked[i] === '{') curly += 1;
    else if (masked[i] === '}') curly -= 1;
    else if (masked[i] === ',' && round === 0 && square === 0 && curly === 0) {
      parts.push(source.slice(start, i)); start = i + 1;
    }
  }
  parts.push(source.slice(start));
  return parts;
}

/**
 * Every binding that holds the ExtensionAPI, plus the offsets of its DECLARATION sites so the
 * no-escape rule can exempt them.
 *
 * Two independent discoveries, unioned, because either can be removed by an edit:
 *   1. any parameter annotated `: ExtensionAPI`;
 *   2. the first parameter of the default-export factory, annotated or not.
 * If both are somehow absent the scanner still holds the line — G1 rejects `.on(` on ANY receiver
 * that is not a discovered binding, so an undiscovered registration surface fails closed.
 */
export function apiBindings(source) {
  const masked = lexicalMask(source);
  const names = new Set();
  const declarations = [];

  for (const match of masked.matchAll(/\b([A-Za-z_$][\w$]*)\s*:\s*ExtensionAPI\b/g)) {
    names.add(match[1]);
    declarations.push([match.index, match.index + match[1].length]);
  }

  const factory = /export\s+default\s+(?:async\s+)?(?:function\b\s*(?:[A-Za-z_$][\w$]*\s*)?)?\(/.exec(masked);
  if (factory) {
    const open = factory.index + factory[0].length - 1;
    const close = matchingParen(masked, open);
    if (close > open) {
      const first = splitTopLevel(masked.slice(open + 1, close))[0] ?? '';
      const identifier = /^\s*([A-Za-z_$][\w$]*)/.exec(first);
      if (identifier) {
        names.add(identifier[1]);
        const at = open + 1 + identifier.index + identifier[0].length - identifier[1].length;
        declarations.push([at, at + identifier[1].length]);
      }
    }
  }
  return { names: [...names], declarations };
}

/** A first argument the scanner can READ: one quoted literal, or a template with no substitution. */
export function literalEventName(argumentSource) {
  const text = (argumentSource ?? '').trim();
  const quoted = /^(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)')$/.exec(text);
  if (quoted) return quoted[1] ?? quoted[2];
  const template = /^`([^`\\$]*)`$/.exec(text);   // no escapes, no `${`
  if (template) return template[1];
  return null;
}

/**
 * The one sanctioned `message_end` handler shape: a direct expression-arrow return of
 * `guardedMessageRewrite(event, inertNote)`.
 *
 * `note` must be an inert identifier or string literal because ARGUMENTS RUN BEFORE THE GUARD —
 * `guardedMessageRewrite(event, noteFor(event))` can mutate the message the guard exists to refuse.
 */
export function directGuardedMessageRewrite(handler) {
  const masked = lexicalMask(handler);
  let round = 0, square = 0, curly = 0, arrow = -1;
  for (let i = 0; i < masked.length - 1; i += 1) {
    if (masked[i] === '(') round += 1;
    else if (masked[i] === ')') round -= 1;
    else if (masked[i] === '[') square += 1;
    else if (masked[i] === ']') square -= 1;
    else if (masked[i] === '{') curly += 1;
    else if (masked[i] === '}') curly -= 1;
    else if (masked.slice(i, i + 2) === '=>' && round === 0 && square === 0 && curly === 0) { arrow = i; break; }
  }
  if (arrow < 0) return false;

  let left = lexicalMask(handler.slice(0, arrow), false).trim().replace(/^async\s+/, '').trim();
  if (left.startsWith('(') && left.endsWith(')')) {
    const parameters = splitTopLevel(left.slice(1, -1));
    if (parameters.length !== 1) return false;
    left = parameters[0].trim();
  }
  const parameter = /^([A-Za-z_$][\w$]*)(?:\s*:\s*(?:any|unknown))?$/.exec(left);
  const eventName = parameter?.[1];
  if (!eventName) return false;

  const right = handler.slice(arrow + 2).trim().replace(/;\s*$/, '');
  const rightMask = lexicalMask(right);
  const guarded = /^guardedMessageRewrite\s*\(/.exec(rightMask);
  if (!guarded) return false;
  const open = rightMask.indexOf('(', guarded.index);
  const close = matchingParen(rightMask, open);
  if (close < 0 || rightMask.slice(close + 1).trim()) return false;
  const args = splitTopLevel(right.slice(open + 1, close));
  if (args.length !== 2 || args[0].trim() !== eventName) return false;

  const note = args[1].trim();
  const identifier = /^[A-Za-z_$][\w$]*$/.test(note) && note !== eventName;
  const stringLiteral = /^(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')$/.test(note);
  return identifier || stringLiteral;
}

/** The one import shape that may supply the sanctioned helper. Aliases and re-exports do not count. */
export function importsSanctionedGuard(source) {
  const executable = lexicalMask(source, false);
  return [...executable.matchAll(
    /^\s*import\s*\{([^}]*)\}\s*from\s*["']\.\.\/src\/safety\.mjs["']\s*;?\s*$/gm)]
    .some(([, specifiers]) => splitTopLevel(specifiers)
      .some((specifier) => specifier.trim() === 'guardedMessageRewrite'));
}

export const RULES = {
  G1: 'a Pi event registration must be a direct dotted call on the ExtensionAPI binding: pi.on(…)',
  G2: 'the ExtensionAPI binding must never be aliased, destructured, indexed or passed on',
  G3: 'the event name must be one plain string literal the audit can read — never computed',
  G4: 'a message_end handler must directly return guardedMessageRewrite(event, inertNote) from ../src/safety.mjs',
};

const EVENT_NAME = /^[a-z][a-z0-9_]*$/;

/**
 * Audit one packaged extension source.
 * Returns `{ registrations, terminalHandlers, findings }`; `findings[].rule` names which rule fired.
 */
export function auditExtensionSource(name, source) {
  const findings = [];
  const add = (rule, detail) => findings.push({ file: name, rule, detail });

  const code = lexicalMask(source);              // comments and strings blanked
  const withStrings = lexicalMask(source, false); // comments blanked, strings intact
  const { names: bindings, declarations } = apiBindings(source);
  const isBinding = (identifier) => bindings.includes(identifier);

  // ── G1a — any bracket-form registration, on any receiver, on any spelling of the key.
  for (const match of withStrings.matchAll(/\b([A-Za-z_$][\w$]*)\s*\[\s*(["'`])on\2\s*\]\s*\(/g)) {
    add('G1', `${match[1]}["on"](…) is a computed registration; write ${match[1]}.on("event", handler)`);
  }

  // ── G2 — the binding must only ever appear as `<binding>.` or at its own declaration.
  for (const binding of bindings) {
    const pattern = new RegExp(`\\b${binding.replace(/\$/g, '\\$')}\\b`, 'g');
    for (const match of code.matchAll(pattern)) {
      if (declarations.some(([start, end]) => match.index >= start && match.index < end)) continue;
      const after = code.slice(match.index + binding.length);
      if (/^\s*\./.test(after)) continue;                       // pi.on / pi.registerTool — fine
      if (/^\s*\[/.test(after)) {
        add('G2', `${binding}[…] — computed access to the ExtensionAPI binding hides the member being called`);
      } else {
        add('G2', `${binding} escapes as a value (alias, destructure, argument or return); the audit can no longer see its registrations`);
      }
    }
  }

  // ── G1b — every dotted `.on(` must sit on a discovered ExtensionAPI binding.
  const registrations = [];
  for (const match of code.matchAll(/\b([A-Za-z_$][\w$]*)\s*\.\s*on\s*\(/g)) {
    const receiver = match[1];
    const open = code.indexOf('(', match.index + match[0].length - 1);
    const close = matchingParen(code, open);
    if (close < 0) { add('G1', `${receiver}.on( has no closing parenthesis the audit can find`); continue; }
    if (!isBinding(receiver)) {
      add('G1', `${receiver}.on(…) is not a registration on the ExtensionAPI binding${bindings.length ? ` (${bindings.join(', ')})` : ' (none discovered)'}`);
      continue;
    }
    const args = splitTopLevel(source.slice(open + 1, close));
    registrations.push({ receiver, args, index: match.index });
  }

  // ── G3 / G4 — a readable event name, then event-specific policy.
  const importsGuard = importsSanctionedGuard(source);
  let terminalHandlers = 0;
  for (const registration of registrations) {
    const event = literalEventName(registration.args[0]);
    if (event === null || !EVENT_NAME.test(event)) {
      add('G3', `${registration.receiver}.on(${(registration.args[0] ?? '').trim().slice(0, 60)}, …) — the event name is not a plain literal, so event-specific policy cannot be applied to it`);
      continue;
    }
    if (event !== 'message_end') continue;
    terminalHandlers += 1;
    if (!importsGuard) {
      add('G4', 'message_end is handled but guardedMessageRewrite is not imported from ../src/safety.mjs');
    }
    if (!directGuardedMessageRewrite(registration.args[1] ?? '')) {
      add('G4', 'message_end must directly return guardedMessageRewrite(event, inertNote) — no block body, no alias, no pre-guard side effect');
    }
  }

  // ── Reconciliation, retained from the prior gate: an executable `message_end` literal that
  //    belongs to no audited registration means the audit and the file disagree about what is there.
  const literals = [...withStrings.matchAll(/(["'`])message_end\1/g)].length;
  if (literals !== terminalHandlers) {
    add('G4', `found ${literals} executable message_end literal(s) but audited ${terminalHandlers} registration(s)`);
  }
  const mentions = [...code.matchAll(/\bguardedMessageRewrite\b/g)].length;
  const expected = (importsGuard ? 1 : 0) + terminalHandlers;
  if (mentions !== expected) {
    add('G4', `guardedMessageRewrite must be one exact import plus one call per audited handler; found ${mentions}, expected ${expected}`);
  }

  return { registrations: registrations.length, terminalHandlers, findings };
}

/** Audit a set of `[name, source]` pairs. */
export function auditExtensionSources(entries) {
  let registrations = 0, terminalHandlers = 0;
  const findings = [];
  for (const [name, source] of entries) {
    const result = auditExtensionSource(name, source);
    registrations += result.registrations;
    terminalHandlers += result.terminalHandlers;
    findings.push(...result.findings);
  }
  return { files: entries.length, registrations, terminalHandlers, findings };
}

export function formatFinding(finding) {
  return `${finding.file} [${finding.rule}] ${finding.detail}`;
}
