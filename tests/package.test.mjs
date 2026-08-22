import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test('package is Pi-first, explicitly ordered, and has no live web entrypoint', async () => {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.ok(pkg.keywords.includes('pi-package'));
  // Order is load order and is load-bearing: guards install result-time protection before anything
  // else can produce a result; butler opens the store; lane is the human surface over it; dream
  // reads what the first three have already written, so it must come last.
  assert.deepEqual(pkg.pi.extensions, [
    './extensions/wos-guards.ts', './extensions/wos-butler.ts', './extensions/wos-lane.ts',
    './extensions/wos-dream.ts',
  ]);
  assert.deepEqual(pkg.pi.skills, ['./skills']);
  assert.equal(pkg.scripts.start, 'pi -e .');
  for (const extension of pkg.pi.extensions) await access(join(root, extension));
  await access(join(root, 'skills', 'wisdom-os-core', 'SKILL.md'));
  await assert.rejects(access(join(root, 'server.mjs')));
  await access(join(root, 'archive', 'web-v0.1', 'server.mjs'));
});

test('public extensions name their production ancestors and contain no private runtime paths', async () => {
  const files = ['wos-guards.ts', 'wos-butler.ts', 'wos-lane.ts', 'wos-dream.ts'];
  for (const file of files) {
    const body = await readFile(join(root, 'extensions', file), 'utf8');
    assert.match(body, /Ported from the production|A53-c9\/c10/,
      `${file} must name its provenance`);
    for (const forbidden of ['/home/']) {
      assert.equal(body.includes(forbidden), false, `${file} leaked private token: ${forbidden}`);
    }
  }
});
