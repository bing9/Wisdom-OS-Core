// Ported from the production `wos-guards.ts` extension (private harness).
// Preserved: the structural terminal-message predicate, append-don't-replace note attachment,
// the sentinel kill switch, and the fail-open wrapper.
// Stripped: private sentinel paths, incident prose, authority registry, personal voice policy.
//
// These four primitives exist because a guard that protects a turn must never be able to cost one.

import { existsSync } from 'node:fs';

/**
 * A guard may append to an assistant message ONLY when that message is terminal.
 *
 * A message carrying a tool call is mid-flight: text appended after the call lands after it, the
 * conversation then ends on an assistant message, and the next request is rejected outright by
 * providers that refuse assistant prefill. The predicate is deliberately STRUCTURAL — it asks
 * whether a tool-call block is present, never whether the prose looks finished.
 *
 * Source: private `wos-guards.ts` `message_end` handler; incident 2026-08-19 (a gate appended to a
 * mid-flight message and the following request failed with "does not support assistant message
 * prefill"). A gate that can break the session is more expensive than every error it will catch.
 */
export const TOOL_CALL_BLOCK_TYPES = ['toolCall', 'tool_use', 'tool-call'];

export function isTerminalMessage(content) {
  if (!Array.isArray(content)) return true;
  return !content.some((block) => TOOL_CALL_BLOCK_TYPES.includes(block?.type));
}

/** True only when this specific message may safely carry an appended guard note. */
export function mayAppendTo(message) {
  if (!message || message.role !== 'assistant') return false;
  return isTerminalMessage(message.content);
}

/**
 * Attach a note WITHOUT replacing the original content, across all three shapes Pi produces.
 * Replacing evidence is how a guard destroys the thing it was reading.
 */
export function appendNote(content, note) {
  if (!note) return content;
  if (Array.isArray(content)) return [...content, { type: 'text', text: note }];
  if (typeof content === 'string') return content + note;
  return [{ type: 'text', text: `${textOf(content)}${note}` }];
}

export function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => typeof part?.text === 'string' ? part.text : '').join('\n');
}

/**
 * One file disables the mechanism immediately, with no restart and no config edit.
 * A control that cannot be switched off in one move will be left on when it misfires.
 */
export function killSwitch(sentinelPath) {
  return () => {
    try { return existsSync(sentinelPath); } catch { return false; }
  };
}

/**
 * Fail OPEN: a harness control must never propagate its own failure into the user's turn.
 * Returns `fallback` (default `undefined`) on any throw, sync or async, and reports via `onError`.
 */
export function failOpen(fn, { fallback = undefined, onError } = {}) {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (error) {
      try { onError?.(error); } catch { /* an error reporter may not throw either */ }
      return fallback;
    }
  };
}
