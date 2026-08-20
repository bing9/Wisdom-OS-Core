import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAppServer } from '../server.mjs';

test('state API persists an updated board to the configured JSON file', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'decision-cockpit-'));
  const dataFile = join(dir, 'board.json');
  const server = createAppServer({ dataFile });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  const nextState = { version: 1, revision: 0, areas: [], decisions: [{ id: 'd1', title: 'Persist me', stage: 'judge', priority: 'P0', humanCall: '' }], tasks: [], feedback: [], runs: [], history: [] };

  const put = await fetch(`${base}/api/state`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(nextState),
  });
  const putResult = await put.json();
  const get = await fetch(`${base}/api/state`);
  const landed = await get.json();
  const disk = JSON.parse(await readFile(dataFile, 'utf8'));

  assert.equal(put.status, 200);
  assert.equal(putResult.revision, 1);
  assert.equal(landed.revision, 1);
  assert.deepEqual(disk, landed);

  const stalePut = await fetch(`${base}/api/state`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...nextState, decisions: [{ ...nextState.decisions[0], title: 'Stale overwrite' }] }),
  });
  assert.equal(stalePut.status, 409);
  assert.equal(JSON.parse(await readFile(dataFile, 'utf8')).decisions[0].title, 'Persist me');

  const butlerResponse = await fetch(`${base}/api/butler/run`, { method: 'POST' });
  const butler = await butlerResponse.json();
  const scannedDisk = JSON.parse(await readFile(dataFile, 'utf8'));

  assert.equal(butlerResponse.status, 200);
  assert.equal(butler.findings[0].type, 'decision-needs-call');
  assert.equal(scannedDisk.butler.findings.length, 1);
  assert.equal(scannedDisk.revision, 1);
  assert.ok(scannedDisk.butler.updatedAt);
});
