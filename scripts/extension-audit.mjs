#!/usr/bin/env node
/**
 * Standalone registration audit — WOSC-221.
 *
 *   node scripts/extension-audit.mjs                 audit this repository's packaged extensions
 *   node scripts/extension-audit.mjs --root <dir>    audit a disposable copy
 *
 * Exit 0 clean · exit 1 findings · exit 2 the audit could not cover anything.
 *
 * This exists so the grammar can be proven WITHOUT the rest of the release gate: point it at a
 * throwaway copy carrying one unsafe computed registration and it must exit 1, while the same copy
 * keeps a legitimate `message_end` handler and an ordinary event registration untouched. A proof
 * that only greps for `message_end` or `guardedMessageRewrite` proves vocabulary, not policy —
 * the exact bypass this repairs contained neither token.
 *
 * It imports the SAME module the release gate imports. There is one grammar, in one place, on
 * purpose: a second copy of a rule is how enforcement drifts away from the claim that names it.
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditExtensionSources, formatFinding, RULES } from '../src/registration-grammar.mjs';

const argv = process.argv.slice(2);
const rootFlag = argv.indexOf('--root');
const ROOT = rootFlag >= 0 && argv[rootFlag + 1]
  ? resolve(argv[rootFlag + 1])
  : dirname(dirname(fileURLToPath(import.meta.url)));

/** Every packaged extension: the manifest's declared entrypoints, unioned with `extensions/`. */
async function packagedExtensions(root) {
  const found = new Map();
  const addFile = async (relativePath) => {
    const absolute = join(root, relativePath);
    try {
      if (!(await stat(absolute)).isFile()) return;
    } catch { return; }
    if (!found.has(relativePath)) found.set(relativePath, await readFile(absolute, 'utf8'));
  };

  try {
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    for (const entry of pkg?.pi?.extensions ?? []) await addFile(entry.replace(/^\.\//, ''));
  } catch { /* a copy without a manifest is still auditable through the directory below */ }

  try {
    for (const name of await readdir(join(root, 'extensions'))) {
      if (/\.(ts|mjs|js)$/.test(name)) await addFile(join('extensions', name));
    }
  } catch { /* no extensions directory */ }

  return [...found.entries()].sort(([a], [b]) => a.localeCompare(b));
}

const entries = await packagedExtensions(ROOT);
console.log(`extension-audit: ${entries.length} packaged extension(s) under ${ROOT}`);
if (entries.length === 0) {
  console.error('extension-audit: nothing to audit — an audit over zero files is not a pass.');
  process.exit(2);
}
for (const [name] of entries) console.log(`  scanned ${name}`);

const { registrations, terminalHandlers, findings } = auditExtensionSources(entries);
console.log(`extension-audit: ${registrations} literal event registration(s) · ${terminalHandlers} message_end handler(s)`);

if (findings.length) {
  console.error('');
  console.error(`extension-audit: ${findings.length} finding(s) — the registration grammar was violated:`);
  for (const finding of findings) console.error(`  ${formatFinding(finding)}`);
  console.error('');
  for (const rule of [...new Set(findings.map((finding) => finding.rule))].sort()) {
    console.error(`  ${rule}: ${RULES[rule]}`);
  }
  process.exit(1);
}
console.log('extension-audit: clean — every registration is a direct dotted call with a literal event name.');
process.exit(0);
