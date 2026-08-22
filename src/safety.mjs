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
 * Attach a note WITHOUT replacing the original content, across every shape Pi produces.
 * Replacing evidence is how a guard destroys the thing it was reading.
 *
 * The single-block object shape used to be stringified through `textOf`, which returns '' for a
 * lone block — so the original was silently dropped while the note survived. An independent
 * verifier found it on 2026-08-22 by passing `{type:'text',text:'original'}`; the test that should
 * have caught it used `{unexpected:true}`, a shape with no text to lose. The object is now carried
 * through verbatim rather than rendered.
 */
export function appendNote(content, note) {
  if (!note) return content;
  if (Array.isArray(content)) return [...content, { type: 'text', text: note }];
  if (typeof content === 'string') return content + note;
  if (content === null || content === undefined) return [{ type: 'text', text: note }];
  return [content, { type: 'text', text: note }];
}

export function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => typeof part?.text === 'string' ? part.text : '').join('\n');
  if (content && typeof content === 'object' && typeof content.text === 'string') return content.text;
  return '';
}

/**
 * THE ONE SANCTIONED PATH for rewriting an assistant message from a `message_end` handler.
 *
 * Returns `undefined` — Pi's "leave it alone" — whenever the message is not terminal, not from the
 * assistant, or there is nothing to add. Handlers must route through this rather than spreading
 * `event.message` themselves: `scripts/release-check.mjs` refuses any extension that touches
 * `event.message` without it, and that refusal is mutation-tested.
 *
 * Source: private `wos-guards.ts`; incident 2026-08-19, where a gate appended to a message carrying
 * a tool call, the conversation ended on an assistant turn, and the next request was rejected for
 * assistant prefill. The gate cost the turn it existed to protect.
 */
export function guardedMessageRewrite(event, note) {
  const message = event?.message;
  if (!note || !mayAppendTo(message)) return undefined;
  return { message: { ...message, content: appendNote(message.content, note) } };
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
