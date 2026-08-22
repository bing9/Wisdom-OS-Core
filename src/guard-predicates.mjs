// Ported from the production `wos-guards.ts` extension.
// The result-time gate predicates, extracted so tests can IMPORT them. A test that re-declares a
// guard's regex proves only that the test's copy works; the shipped predicate stays unexercised.
// PORTABILITY.md is explicit: a second full implementation is a defect.

export const TRANSIENT = [
  /Input\/output error/i, /Resource temporarily unavailable/i, /Stale file handle/i,
  /Transport endpoint is not connected/i, /Connection reset|Connection refused|Broken pipe/i,
  /\brc=124\b|\bexit(?: code)? 124\b/i, /timed out|timeout after|Operation timed out/i,
  /Temporary failure in name resolution/i,
];
export const SEARCHY = /\b(grep|rg|find|ls|fd|locate|glob|internal-rg)\b/;
export const NO_MATCH = [/(?:^|\n)\s*(?:exit|rc)=1\s*\n?$/, /\bEXIT:? 1\b/, /No results found/i,
  /no matches found/i, /^\s*0\s*$/];
export const PARTIAL = /Permission denied|cannot access|cannot open|Operation not permitted/i;

export const FAILED = /\bexit=[1-9]|\brc=[1-9]|\bEXIT:? *[1-9]/;

const searchy = (command, toolName) => SEARCHY.test(String(command ?? '')) || SEARCHY.test(String(toolName ?? ''));

/** A failure whose class is transient: retrying is owed before any "broken / stale / absent" claim. */
export function transient(body, isError = false) {
  const text = String(body ?? '');
  return (isError === true || FAILED.test(text)) && TRANSIENT.some((pattern) => pattern.test(text));
}

/** An empty or zero-hit search result bounds only the roots that were actually searched. */
export function noMatch(body, command, toolName) {
  const text = String(body ?? '');
  return searchy(command, toolName) && (text.trim() === '' || NO_MATCH.some((pattern) => pattern.test(text)));
}

/** Part of the requested range was unreadable, so absence over the whole range is unproven. */
export function partialCoverage(body, command, toolName) {
  return searchy(command, toolName) && PARTIAL.test(String(body ?? ''));
}

/** The declared gate ids, in the order the handler evaluates them. */
export const GATE_IDS = ['transient-class-failure', 'absence-from-partial-search', 'partial-coverage'];

/** Which gates a single tool result trips. Pure, so a fixture replay needs no Pi runtime. */
export function evaluateGates({ body = '', command = '', toolName = '', isError = false } = {}) {
  const fired = [];
  if (transient(body, isError)) fired.push('transient-class-failure');
  if (noMatch(body, command, toolName)) fired.push('absence-from-partial-search');
  if (partialCoverage(body, command, toolName)) fired.push('partial-coverage');
  return fired;
}
