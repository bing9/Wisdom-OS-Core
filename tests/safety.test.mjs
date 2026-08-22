import assert from 'node:assert/strict';
import test from 'node:test';
import { appendNote, failOpen, guardedMessageRewrite, isTerminalMessage, killSwitch, mayAppendTo, textOf } from '../src/safety.mjs';

test('a message carrying a tool call is not terminal and may not be appended to', () => {
  // The incident predicate: appending here ends the conversation on an assistant message and the
  // next request is rejected for assistant prefill.
  const midFlight = [{ type: 'text', text: 'Running it now.' }, { type: 'toolCall', id: 't1' }];
  assert.equal(isTerminalMessage(midFlight), false);
  assert.equal(mayAppendTo({ role: 'assistant', content: midFlight }), false);

  const snakeCase = [{ type: 'text', text: 'x' }, { type: 'tool_use', id: 't2' }];
  assert.equal(isTerminalMessage(snakeCase), false);

  const terminal = [{ type: 'text', text: 'Done — 4 files changed.' }];
  assert.equal(isTerminalMessage(terminal), true);
  assert.equal(mayAppendTo({ role: 'assistant', content: terminal }), true);
});

test('the predicate is structural, not prose-based, and only assistant messages qualify', () => {
  // A finished-sounding sentence beside a tool call is still mid-flight.
  const looksDone = [{ type: 'text', text: 'That completes the work.' }, { type: 'toolCall', id: 't3' }];
  assert.equal(isTerminalMessage(looksDone), false);
  // A plain string has no blocks to inspect and is treated as terminal.
  assert.equal(isTerminalMessage('plain answer'), true);
  // Role still gates it.
  assert.equal(mayAppendTo({ role: 'user', content: 'hi' }), false);
  assert.equal(mayAppendTo(null), false);
});

test('appendNote adds to every content shape and never replaces the original evidence', () => {
  const blocks = [{ type: 'text', text: 'original' }];
  const appended = appendNote(blocks, '\nNOTE');
  assert.equal(appended.length, 2);
  assert.equal(appended[0].text, 'original', 'the original block must survive verbatim');
  assert.equal(appended[1].text, '\nNOTE');
  assert.deepEqual(blocks, [{ type: 'text', text: 'original' }], 'input must not be mutated');

  assert.equal(appendNote('original', '\nNOTE'), 'original\nNOTE');
  assert.equal(appendNote(blocks, ''), blocks, 'an empty note is a no-op');
});

test('a single-block object keeps its original content — the shape that silently lost it', () => {
  // The old fallback stringified through textOf, which returned '' for a lone block, so the
  // original vanished and only the note survived. The earlier test used `{unexpected:true}` — a
  // shape with no text to lose — and therefore could not fail. An independent verifier found this
  // by passing a block that DID carry text.
  const single = { type: 'text', text: 'original' };
  const appended = appendNote(single, '\nNOTE');
  assert.equal(Array.isArray(appended), true);
  assert.deepEqual(appended[0], single, 'the original block must survive verbatim, not be rendered');
  assert.equal(appended[1].text, '\nNOTE');
  assert.equal(textOf(single), 'original', 'textOf must read a lone block, not return empty');

  // Shapes with genuinely nothing to preserve still produce the note.
  assert.deepEqual(appendNote(null, '\nNOTE'), [{ type: 'text', text: '\nNOTE' }]);
  assert.deepEqual(appendNote(undefined, '\nNOTE'), [{ type: 'text', text: '\nNOTE' }]);
  const opaque = appendNote({ unexpected: true }, '\nNOTE');
  assert.deepEqual(opaque[0], { unexpected: true }, 'even an unrecognised shape is carried, not dropped');
});

test('guardedMessageRewrite is the only safe way to rewrite an assistant message', () => {
  const note = '\nGUARD NOTE';
  // Refuses everything unsafe, by returning Pi's "leave it alone".
  assert.equal(guardedMessageRewrite({ message: { role: 'assistant',
    content: [{ type: 'text', text: 'x' }, { type: 'toolCall', id: 't' }] } }, note), undefined,
    'a mid-flight message must be left alone');
  assert.equal(guardedMessageRewrite({ message: { role: 'user', content: [] } }, note), undefined);
  assert.equal(guardedMessageRewrite({ message: { role: 'assistant', content: [] } }, ''), undefined,
    'an empty note is not a reason to rewrite');
  assert.equal(guardedMessageRewrite({}, note), undefined);
  assert.equal(guardedMessageRewrite(undefined, note), undefined);

  // Appends on the one safe path, preserving the original and every other message field.
  const event = { message: { role: 'assistant', id: 'm1', content: [{ type: 'text', text: 'done' }] } };
  const out = guardedMessageRewrite(event, note);
  assert.equal(out.message.id, 'm1', 'other message fields must survive');
  assert.deepEqual(out.message.content[0], { type: 'text', text: 'done' });
  assert.equal(out.message.content[1].text, note);
  assert.deepEqual(event.message.content, [{ type: 'text', text: 'done' }], 'the input must not be mutated');
});

test('killSwitch reads a sentinel file and reports false when it cannot look', () => {
  assert.equal(killSwitch('/nonexistent/path/that/should/not/exist')(), false);
  // A sentinel that does exist reads true; use a path guaranteed present on any POSIX host.
  assert.equal(killSwitch('/etc/hostname')() || killSwitch('/etc/passwd')(), true);
});

test('failOpen swallows the failure, reports it, and returns the declared fallback', async () => {
  const seen = [];
  const wrapped = failOpen(async () => { throw new Error('disk full'); },
    { fallback: 'FELL-BACK', onError: (error) => seen.push(error.message) });
  assert.equal(await wrapped(), 'FELL-BACK');
  assert.deepEqual(seen, ['disk full']);

  // Default fallback is undefined — the shape a Pi lifecycle hook uses for "do nothing".
  assert.equal(await failOpen(async () => { throw new Error('x'); })(), undefined);
  // A throwing error reporter must not resurrect the failure.
  const hostile = failOpen(async () => { throw new Error('x'); }, { onError: () => { throw new Error('reporter'); } });
  assert.equal(await hostile(), undefined);
  // The happy path is untouched, arguments and all.
  assert.equal(await failOpen(async (a, b) => a + b)(2, 3), 5);
});
