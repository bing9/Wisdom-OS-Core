import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (rel) => readFile(join(root, 'pi-config', rel), 'utf8');

// Prose artifacts a mechanical sanitizer leaves behind (see docs/DECISIONS.md D23). Both AGENTS outputs
// must be free of them; the exporter refuses on the same list, this test re-checks the committed files.
const ARTIFACTS = [
  ['past-the owner', /past-the owner/],
  ['the owner-owned', /the owner-owned/],
  ['the owner-lane', /the owner-lane/],
  ['a the owner', /\ba the owner\b/],
  ['team memory Memory', /team memory Memory/],
  ['wisdom-os WOS', /wisdom-os WOS/],
  ['duplicated root', /(`\$WISDOM_OS_ROOT\/[^`]*`) or \1/],
  ['he/his/him', /\b(?:he|his|him)\b/i],
  ['ruling date', /\d{4}-\d\d-\d\d/],
];
const TEMPLATE_ONLY = [
  ['language rule', /Chinese/i],
  ['owner philosophy', /Three Razors|<Razor 1/i],
];

test('AGENTS owner example carries no sanitizer artifacts', async () => {
  const body = await read('examples/AGENTS.owner-example.md');
  assert.match(body, /Three Razors/, 'the worked example keeps the owner philosophy');
  for (const [name, rx] of ARTIFACTS) assert.doesNotMatch(body, rx, `owner example: ${name}`);
});

test('AGENTS neutral template is owner-free and has fill-in placeholders', async () => {
  const body = await read('templates/AGENTS.md.template');
  for (const [name, rx] of [...ARTIFACTS, ...TEMPLATE_ONLY]) assert.doesNotMatch(body, rx, `template: ${name}`);
  for (const section of ['## Operating contract', '## Hard invariants']) assert.ok(body.includes(section), section);
  assert.ok((body.match(/<<FILL:/g) ?? []).length >= 4, 'placeholders for purpose, philosophy, preferences, folder map');
});

test('the artifact patterns can fail (negative control)', () => {
  const planted = 'Divergence from past-the owner; OM is the owner-owned; he wants it (2026-09-26).';
  const caught = ARTIFACTS.filter(([, rx]) => rx.test(planted)).map(([name]) => name);
  assert.deepEqual(caught, ['past-the owner', 'the owner-owned', 'he/his/him', 'ruling date']);
});
