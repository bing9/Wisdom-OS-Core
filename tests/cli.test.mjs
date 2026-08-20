import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const root = dirname(dirname(fileURLToPath(import.meta.url)));

test('CLI reads the direct local store; no HTTP server is required', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wisdom-os-cli-'));
  try {
    const dataFile = join(dir, 'state.json');
    const board = {
      version: 2, revision: 0,
      areas: [{ id: 'a1', name: 'Product', director: 'DIR-product' }],
      decisions: [{ id: 'd1', title: 'Pick wedge', areaId: 'a1', stage: 'judge', priority: 'P0', humanCall: '', whyNow: 'Need focus', options: [{ choice: 'A', sacrifice: 'B' }, { choice: 'C', sacrifice: 'D' }] }],
      tasks: [{ id: 't1', title: 'Build Pi slice', decisionId: 'd1', areaId: 'a1', stage: 'doing', acceptance: 'Works in a fresh Pi session' }],
      feedback: [], runs: [], history: [], cases: [], precedentUses: [], receipts: [], events: [],
    };
    await writeFile(dataFile, JSON.stringify(board));
    const env = { ...process.env, WISDOM_OS_STATE: dataFile };

    const butler = await execFileAsync(process.execPath, ['cli.mjs', 'butler'], { cwd: root, env });
    const handoff = await execFileAsync(process.execPath, ['cli.mjs', 'handoff', 'decision', 'd1'], { cwd: root, env });

    assert.match(butler.stdout, /decision-needs-call/);
    assert.match(handoff.stdout, /Pick wedge/);
    assert.match(handoff.stdout, /DIR-product/);
    assert.match(handoff.stdout, /Build Pi slice/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
