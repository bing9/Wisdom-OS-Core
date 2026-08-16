import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createAppServer } from '../server.mjs';

const execFileAsync = promisify(execFile);
const root = dirname(dirname(fileURLToPath(import.meta.url)));

test('CLI lets an agent scan the Butler brief and generate a restartable handoff', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'decision-cockpit-cli-'));
  const dataFile = join(dir, 'board.json');
  const board = {
    version: 1,
    areas: [{ id: 'a1', name: 'Product', director: 'DIR-product' }],
    decisions: [{ id: 'd1', title: 'Pick wedge', areaId: 'a1', stage: 'judge', priority: 'P0', humanCall: '', whyNow: 'Need focus', options: [{ choice: 'A', sacrifice: 'B' }, { choice: 'C', sacrifice: 'D' }] }],
    tasks: [{ id: 't1', title: 'Build slice', decisionId: 'd1', areaId: 'a1', stage: 'doing', acceptance: 'Works' }],
    feedback: [], runs: [], history: [],
  };
  await writeFile(dataFile, JSON.stringify(board));
  const server = createAppServer({ dataFile });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  const env = { ...process.env, DECISION_COCKPIT_URL: `http://127.0.0.1:${server.address().port}` };

  const butler = await execFileAsync(process.execPath, ['cli.mjs', 'butler'], { cwd: root, env });
  const handoff = await execFileAsync(process.execPath, ['cli.mjs', 'handoff', 'decision', 'd1'], { cwd: root, env });

  assert.match(butler.stdout, /decision-needs-call/);
  assert.match(handoff.stdout, /Pick wedge/);
  assert.match(handoff.stdout, /DIR-product/);
  assert.match(handoff.stdout, /Build slice/);
});
