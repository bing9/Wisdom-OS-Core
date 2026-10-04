#!/usr/bin/env node
/**
 * Portability / publish audit. Scans what is actually PUBLISHED, not what package.json lists.
 *
 *   node scripts/portability-audit.mjs [--range A..B]
 *
 * Population  every `git ls-files` path (a copy without .git — the release gate's mutation children —
 *             falls back to walking the copy). Binary/undecodable files are printed as skipped, never
 *             silently dropped; zero files scanned is a failure.
 * Deny list   the employer/people/project terms are the secret, so they are NEVER committed here. They
 *             resolve, in order, from PORTABILITY_DENY_TERMS (comma list) → the file named by
 *             WOSC_DENY_FILE → $XDG_CONFIG_HOME/wisdom-os-core/deny.txt (default ~/.config/…). When no
 *             source resolves the audit exits 2 with "deny list unavailable" — the uncheckable case and
 *             the clean case must never look the same.
 *             File format, one per line: `re:<flags>:<regex>` · `term:<literal>` · `# comment`.
 * History     over the outgoing range (--range, else WOSC_RANGE, else origin/main..HEAD when origin/main
 *             exists): every author AND committer email must equal the public noreply identity
 *             (allow-list, not deny-list), and every commit message is scanned like a file.
 * Built-in    structural rules that are not secrets: personal home paths, request-id shapes, the
 *             retired live web entrypoint.
 *
 * Exit: 0 clean · 1 findings · 2 deny list unavailable · 3 could not enumerate the population.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const ALLOWED_IDENTITY = '8092455+bing9@users.noreply.github.com';
const argv = process.argv.slice(2);
const argRange = argv.includes('--range') ? argv[argv.indexOf('--range') + 1] : undefined;

const builtin = [
  ['private home', /\/(?:home|Users)\/(?!<)[a-z0-9._-]+\//i],
  ['request id', /\breq-[a-z0-9]+(?:-[a-z0-9]+)*-20\d{6}(?:-\d+)?\b/],
  ['request id', /(?<![\w/])req-[a-z][a-z0-9]*(?:-[a-z0-9]+)+/],
];

function toJsRegex(source, flags) {
  // sanitize.py patterns are Python regexes: drop an inline (?i) and a \b that touches a non-ASCII
  // character (Python's \b is Unicode-aware, JavaScript's is not).
  let s = source, f = flags;
  if (s.startsWith('(?i)')) { s = s.slice(4); f += 'i'; }
  s = s.replace(/\\b(?=[^\x00-\x7f])/g, '').replace(/(?<=[^\x00-\x7f])\\b/g, '');
  return new RegExp(s, [...new Set(f)].join(''));
}

function loadDeny() {
  const env = String(process.env.PORTABILITY_DENY_TERMS ?? '').split(',').map((t) => t.trim()).filter(Boolean);
  if (env.length) return { source: 'PORTABILITY_DENY_TERMS', rules: env.map((t) => ['deny term', literal(t)]) };
  const candidates = [process.env.WOSC_DENY_FILE,
    join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'wisdom-os-core', 'deny.txt')].filter(Boolean);
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const rules = [];
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.trim() || line.startsWith('#')) continue;
      if (line.startsWith('term:')) rules.push(['deny term', literal(line.slice(5))]);
      else if (line.startsWith('re:')) {
        const rest = line.slice(3), cut = rest.indexOf(':');
        try { rules.push(['deny pattern', toJsRegex(rest.slice(cut + 1), rest.slice(0, cut))]); }
        catch (error) { console.error(`portability-audit: unreadable deny pattern skipped LOUDLY: ${error.message}`); return null; }
      }
    }
    if (rules.length) return { source: path, rules };
  }
  return null;
}

function literal(term) {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, 'i');
}

function git(...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 });
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === '.git' || name === 'node_modules') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...walk(path)); else out.push(relative(root, path));
  }
  return out;
}

const deny = loadDeny();
if (!deny) {
  console.error('portability-audit: FAIL deny list unavailable — set PORTABILITY_DENY_TERMS or WOSC_DENY_FILE, or '
    + 'install ~/.config/wisdom-os-core/deny.txt. Refusing to report a clean result that checked no terms.');
  process.exit(2);
}
const rules = [...builtin, ...deny.rules];

let files, population, inGit = false;
try {
  files = git('ls-files', '-z').split('\0').filter(Boolean);
  population = 'git ls-files';
  inGit = true;
} catch {
  files = walk(root);
  population = 'a walk of this copy (no git checkout)';
}
if (!files.length) { console.error('portability-audit: FAIL zero files — a dead audit, not a pass'); process.exit(3); }

const hits = [], skipped = [];
let scanned = 0;
for (const rel of files.sort()) {
  if (/(?:^|\/)server\.mjs$/i.test(rel) && !rel.startsWith('archive/')) hits.push({ klass: 'live web entrypoint', where: rel });
  let raw;
  try { raw = readFileSync(join(root, rel)); } catch (error) { skipped.push(`${rel} (unreadable: ${error.code})`); continue; }
  if (raw.subarray(0, 8192).includes(0)) { skipped.push(`${rel} (binary)`); continue; }
  const body = raw.toString('utf8');
  if (body.includes('\uFFFD')) { skipped.push(`${rel} (not utf-8)`); continue; }
  scanned += 1;
  scanText(body, rel);
}

function scanText(body, where) {
  const lines = body.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    for (const [klass, pattern] of rules) if (pattern.test(lines[i])) hits.push({ klass, where: `${where}:${i + 1}` });
  }
}

let range = argRange ?? process.env.WOSC_RANGE, commits = 0;
const identity = [];
if (inGit && !range) {
  try { git('rev-parse', '--verify', '-q', 'refs/remotes/origin/main'); range = 'origin/main..HEAD'; } catch { /* no remote */ }
}
if (inGit && range) {
  const log = git('log', '-z', '--format=%H%x1f%ae%x1f%ce%x1f%B', range).split('\0').filter((entry) => entry.trim());
  for (const entry of log) {
    const [sha, author, committer, message] = entry.replace(/^\n/, '').split('\x1f');
    commits += 1;
    if (author !== ALLOWED_IDENTITY) identity.push(`${sha.slice(0, 12)} author ${author}`);
    if (committer !== ALLOWED_IDENTITY) identity.push(`${sha.slice(0, 12)} committer ${committer}`);
    scanText(message ?? '', `commit ${sha.slice(0, 12)} message`);
  }
}

const dirs = [...new Set(files.map((path) => (path.includes('/') ? path.split('/')[0] : '.')))].sort();
console.log(`portability-audit: ${scanned} files under ${population} (${dirs.join(', ')}); `
  + `${skipped.length} skipped; deny source ${deny.source === 'PORTABILITY_DENY_TERMS' ? deny.source : 'file'} `
  + `(${deny.rules.length} rules); history ${range ? `${range}: ${commits} commit(s)` : 'not checked (no range: no git or no origin/main)'}`);
for (const entry of skipped) console.log(`  SKIPPED ${entry}`);
if (scanned === 0) { console.error('portability-audit: FAIL zero files scanned'); process.exit(3); }
for (const entry of identity) console.error(`FAIL identity not allow-listed: ${entry}`);
for (const hit of hits) console.error(`FAIL ${hit.klass}: ${hit.where}`);   // never echoes the matched text
if (hits.length || identity.length) process.exit(1);
console.log('PASS — 0 private/personal/internal/live-web findings; identity allow-listed');
