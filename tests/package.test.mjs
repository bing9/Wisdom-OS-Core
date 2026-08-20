import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test('package is Pi-first, explicitly ordered, and has no live web entrypoint', async () => {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.ok(pkg.keywords.includes('pi-package'));
  assert.deepEqual(pkg.pi.extensions, [
    './extensions/wos-guards.ts', './extensions/wos-butler.ts', './extensions/wos-lane.ts',
  ]);
  assert.deepEqual(pkg.pi.skills, ['./skills']);
  assert.equal(pkg.scripts.start, 'pi -e .');
  for (const extension of pkg.pi.extensions) await access(join(root, extension));
  await access(join(root, 'skills', 'wisdom-os-core', 'SKILL.md'));
  await assert.rejects(access(join(root, 'server.mjs')));
  await access(join(root, 'archive', 'web-v0.1', 'server.mjs'));
});

test('public extensions name their production ancestors and contain no private runtime paths', async () => {
  const files = ['wos-guards.ts', 'wos-butler.ts', 'wos-lane.ts'];
  for (const file of files) {
    const body = await readFile(join(root, 'extensions', file), 'utf8');
    assert.match(body, /Ported from the production/);
    for (const forbidden of ['/home/']) {
      assert.equal(body.includes(forbidden), false, `${file} leaked private token: ${forbidden}`);
    }
  }
});
