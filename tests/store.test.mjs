import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyState, readState, updateState, writeState } from '../src/store.mjs';

test('store writes atomically, reads back, and increments revisions under concurrent updates', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wisdom-os-store-'));
  try {
    const path = join(dir, 'state.json');
    await writeState(path, emptyState());

    await Promise.all(Array.from({ length: 10 }, (_, i) => updateState(path, (state) => {
      state.events.push({ id: `e${i}`, type: 'test' });
      return state;
    })));

    const state = await readState(path);
    assert.equal(state.revision, 10);
    assert.equal(state.events.length, 10);
    assert.equal(new Set(state.events.map((event) => event.id)).size, 10);
    const raw = await readFile(path, 'utf8');
    assert.doesNotThrow(() => JSON.parse(raw));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('v1 state migrates in memory to the v2 accumulation arrays', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wisdom-os-migrate-'));
  try {
    const path = join(dir, 'state.json');
    await writeState(path, { version: 1, revision: 2, areas: [], decisions: [], tasks: [], feedback: [], runs: [], history: [] });
    const state = await readState(path);
    assert.equal(state.version, 2);
    assert.deepEqual(state.cases, []);
    assert.deepEqual(state.precedentUses, []);
    assert.deepEqual(state.receipts, []);
    assert.deepEqual(state.events, []);
    assert.deepEqual(state.processSignals, []);
    assert.deepEqual(state.improvements, []);
    await assert.doesNotReject(readFile(path, 'utf8'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
