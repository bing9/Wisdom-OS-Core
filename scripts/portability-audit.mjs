#!/usr/bin/env node
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const roots = (pkg.files ?? []).map((entry) => join(root, entry));
const forbidden = [
  ['private home', /\/home\/[a-z0-9._-]+/i],
  ['live web entrypoint', /(?:^|\/)server\.mjs$/i],
];
const textExt = /\.(?:ts|js|mjs|json|md|yml|yaml)$/i;

async function walk(path) {
  const info = await stat(path);
  if (info.isFile()) return [path];
  const out = [];
  for (const name of await readdir(path)) out.push(...await walk(join(path, name)));
  return out;
}

const self = fileURLToPath(import.meta.url);
const files = (await Promise.all(roots.map(walk))).flat()
  .filter((path) => textExt.test(path) && resolve(path) !== resolve(self));
const localDeny = String(process.env.PORTABILITY_DENY_TERMS ?? '').split(',').map((term) => term.trim()).filter(Boolean);
for (const term of localDeny) {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  forbidden.push([`local deny term ${term}`, new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, 'i')]);
}
const hits = [];
for (const path of files) {
  const body = await readFile(path, 'utf8');
  const rel = relative(root, path);
  for (const [klass, pattern] of forbidden) {
    if ((klass === 'live web entrypoint' ? pattern.test(rel) : pattern.test(body))) hits.push({ klass, path: rel });
  }
}

console.log(`portability-audit: ${files.length} files under ${roots.map((path) => relative(root, path)).join(', ')}`);
if (hits.length) {
  for (const hit of hits) console.error(`FAIL ${hit.klass}: ${hit.path}`);
  process.exit(1);
}
console.log('PASS — 0 private/personal/internal/live-web findings');
