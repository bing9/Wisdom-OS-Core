import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateGates, GATE_IDS, noMatch, partialCoverage, transient } from '../src/guard-predicates.mjs';

// Positive fixtures. Each is a shape that actually reached a turn.
test('transient fires only when the failure is BOTH failed and transient-class', () => {
  assert.equal(transient('bash: rc=124 timed out', false), true);
  assert.equal(transient('Stale file handle', true), true);
  assert.equal(transient('exit=1\nTransport endpoint is not connected', false), true);

  // False-positive controls: the gate must NOT fire on these.
  assert.equal(transient('Stale file handle', false), false,
    'transient text with no failure signal is prose, not an incident');
  assert.equal(transient('exit=1\nsyntax error near unexpected token', false), false,
    'a real deterministic failure must not be excused as transient');
  assert.equal(transient('', true), false, 'an error with no transient class is not transient');
  assert.equal(transient('all tests passed in 124 ms', false), false);
});

test('no-match fires only on a searching command with an empty or zero-hit result', () => {
  assert.equal(noMatch('', 'grep -r foo .', 'bash'), true);
  assert.equal(noMatch('No results found', 'rg foo', 'bash'), true);
  assert.equal(noMatch('   \n0\n', 'find . -name x', 'bash'), true);
  assert.equal(noMatch('anything', '', 'glob'), false, 'toolName glob with a non-empty body is a hit');
  assert.equal(noMatch('', '', 'glob'), true, 'the tool name alone can mark it as a search');

  // False-positive controls.
  assert.equal(noMatch('', 'python3 build.py', 'bash'), false,
    'a silent non-search command is not an absence claim');
  assert.equal(noMatch('src/domain.mjs\nsrc/store.mjs', 'grep -rl foo .', 'bash'), false,
    'a search that found things must not be flagged as empty');
});

test('partial-coverage fires when part of the searched range was unreadable', () => {
  assert.equal(partialCoverage('grep: /root/x: Permission denied', 'grep -r foo /', 'bash'), true);
  assert.equal(partialCoverage('find: cannot access /proc/1', 'find / -name x', 'bash'), true);

  // False-positive controls.
  assert.equal(partialCoverage('Permission denied', 'chmod 600 f', 'bash'), false,
    'a permission error outside a search is not partial search coverage');
  assert.equal(partialCoverage('src/a.mjs', 'grep -r foo .', 'bash'), false);
});

test('a single result can trip several gates, and the declared ids are exactly the implemented ones', () => {
  const fired = evaluateGates({
    body: 'rc=124 timed out\ngrep: /root: Permission denied',
    command: 'grep -r foo /', toolName: 'bash', isError: true,
  });
  assert.deepEqual(fired, ['transient-class-failure', 'partial-coverage']);

  // Every declared id must be reachable by some fixture — a gate no input can trip is not a gate.
  const reachable = new Set([
    ...evaluateGates({ body: 'rc=124 timed out', command: 'ls', isError: true }),
    ...evaluateGates({ body: '', command: 'grep foo', toolName: 'bash' }),
    ...evaluateGates({ body: 'Permission denied', command: 'grep -r foo /', toolName: 'bash' }),
  ]);
  assert.deepEqual([...reachable].sort(), [...GATE_IDS].sort());
});

test('a clean result trips nothing — the quiet path is the common path', () => {
  assert.deepEqual(evaluateGates({ body: 'ok, 4 files changed', command: 'git status', toolName: 'bash' }), []);
  assert.deepEqual(evaluateGates({}), [], 'an empty event must not be read as an empty search');
});
