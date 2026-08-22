import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { gateCoverage, gateEvent, gateManifest, logGate, parseGateEvents, writeManifest } from '../src/gatelog.mjs';

const GATES = [
  { id: 'transient-class-failure', hook: 'tool_result', shipped: '2026-08-19' },
  { id: 'partial-coverage', hook: 'tool_result', shipped: '2026-08-19' },
];

test('a redeploy never re-dates an existing gate', () => {
  const first = gateManifest(GATES, {}, '2026-08-19T00:00:00.000Z');
  assert.equal(first.gates['transient-class-failure'].shipped, '2026-08-19');
  // Same ids, later run, and a source that now claims a newer ship date.
  const relabelled = GATES.map((gate) => ({ ...gate, shipped: '2026-08-22' }));
  const second = gateManifest(relabelled, first, '2026-08-22T00:00:00.000Z');
  assert.equal(second.gates['transient-class-failure'].shipped, '2026-08-19',
    'a long-standing control must not be made to look new');
  assert.equal(second.updated, '2026-08-22T00:00:00.000Z');
});

test('a gate dropped from the code is retired, not vanished', () => {
  const before = gateManifest(GATES, {}, '2026-08-19T00:00:00.000Z');
  const after = gateManifest([GATES[0]], before, '2026-08-22T00:00:00.000Z');
  assert.equal(after.gates['partial-coverage'], undefined);
  assert.equal(after.retired['partial-coverage'].shipped, '2026-08-19');
  assert.equal(after.retired['partial-coverage'].retiredAt, '2026-08-22T00:00:00.000Z');
});

test('a gate without an id is rejected rather than silently keyed as undefined', () => {
  assert.throws(() => gateManifest([{ hook: 'tool_result' }]), /needs an id/);
  assert.throws(() => gateEvent({ detail: 'x' }), /gateId is required/);
});

test('every gate hit records whether the path that fired it was synthetic', () => {
  const real = gateEvent({ gateId: 'partial-coverage', detail: 'x', now: '2026-08-22T00:00:00.000Z' });
  assert.equal(real.synthetic, false);
  assert.equal(real.caughtBy, 'gate');
  const fake = gateEvent({ gateId: 'partial-coverage', synthetic: true, now: '2026-08-22T00:00:00.000Z' });
  assert.equal(fake.synthetic, true);
  // Detail and command are bounded so a journal cannot grow without information.
  assert.equal(gateEvent({ gateId: 'g', detail: 'y'.repeat(9000) }).detail.length, 200);
});

test('coverage separates never-fired, synthetic-only, and live gates', () => {
  const manifest = gateManifest([...GATES, { id: 'absence-from-partial-search', hook: 'tool_result' }], {},
    '2026-08-22T00:00:00.000Z');
  const events = [
    gateEvent({ gateId: 'transient-class-failure', synthetic: true }),
    gateEvent({ gateId: 'transient-class-failure', synthetic: true }),
    gateEvent({ gateId: 'partial-coverage', synthetic: true }),
    gateEvent({ gateId: 'partial-coverage', synthetic: false }),
    gateEvent({ gateId: 'undeclared-gate', synthetic: false }),
  ];
  const coverage = gateCoverage(manifest, events);
  assert.deepEqual(coverage.syntheticOnly, ['transient-class-failure'],
    'a gate proven only by its own tests must not be described as working');
  assert.deepEqual(coverage.live, ['partial-coverage']);
  assert.deepEqual(coverage.never, ['absence-from-partial-search']);
  assert.deepEqual(coverage.undeclared, ['undeclared-gate'],
    'a gate firing without being declared is a manifest defect, not a silent pass');
});

test('the journal is append-only, survives a corrupt line, and stays bounded', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wos-gatelog-'));
  try {
    const path = join(dir, 'nested', 'gate-events.jsonl');
    assert.equal(await logGate(path, gateEvent({ gateId: 'a' })), true, 'creates its own directory');
    assert.equal(await logGate(path, gateEvent({ gateId: 'b' })), true);
    const body = await readFile(path, 'utf8');
    assert.equal(parseGateEvents(body).length, 2);
    assert.equal(parseGateEvents(`${body}{ not json\n`).length, 2, 'one bad line must not lose the rest');
    assert.equal(parseGateEvents(body, 1).length, 1, 'the tail is what is retained');

    const manifestPath = join(dir, 'gate-manifest.json');
    await writeManifest(manifestPath, GATES, '2026-08-19T00:00:00.000Z');
    const reloaded = await writeManifest(manifestPath, GATES, '2026-08-22T00:00:00.000Z');
    assert.equal(reloaded.gates['partial-coverage'].shipped, '2026-08-19',
      'the on-disk round trip preserves the original ship date');
    assert.deepEqual(JSON.parse(await readFile(manifestPath, 'utf8')), reloaded);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a journal it cannot write reports false instead of ending the turn', async () => {
  // A path whose parent cannot be created: the guard must degrade, never throw.
  assert.equal(await logGate('/proc/self/mem/impossible/gate.jsonl', gateEvent({ gateId: 'a' })), false);
});
