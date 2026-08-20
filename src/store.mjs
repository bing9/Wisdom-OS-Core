import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const emptyState = () => ({
  version: 2,
  revision: 0,
  areas: [],
  decisions: [],
  tasks: [],
  feedback: [],
  runs: [],
  history: [],
  cases: [],
  precedentUses: [],
  receipts: [],
  events: [],
  processSignals: [],
  improvements: [],
});

const ARRAY_KEYS = [
  'areas', 'decisions', 'tasks', 'feedback', 'runs', 'history',
  'cases', 'precedentUses', 'receipts', 'events', 'processSignals', 'improvements',
];

export function normalizeState(input = {}) {
  const state = { ...emptyState(), ...input, version: 2 };
  for (const key of ARRAY_KEYS) if (!Array.isArray(state[key])) state[key] = [];
  if (!Number.isInteger(state.revision)) state.revision = 0;
  return state;
}

export function validState(input) {
  return Boolean(input && [1, 2].includes(input.version) &&
    ['areas', 'decisions', 'tasks', 'feedback', 'runs', 'history']
      .every((key) => Array.isArray(input[key])));
}

export function projectKey(cwd = process.cwd()) {
  const name = resolve(cwd).split(/[\\/]/).filter(Boolean).at(-1) || 'root';
  const hash = createHash('sha256').update(resolve(cwd)).digest('hex').slice(0, 12);
  return `${name.replace(/[^a-zA-Z0-9._-]+/g, '-')}-${hash}`;
}

/** Default is private and outside the project. A checked-in .wisdom-os/state.json opts into sharing. */
export async function resolveStatePath(cwd = process.cwd(), env = process.env) {
  if (env.WISDOM_OS_STATE) return resolve(env.WISDOM_OS_STATE);
  const shared = join(resolve(cwd), '.wisdom-os', 'state.json');
  try { await stat(shared); return shared; } catch { /* private default */ }
  return join(homedir(), '.wisdom-os', 'projects', projectKey(cwd), 'state.json');
}

export async function readState(path) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    if (!validState(parsed)) throw new Error(`Invalid Wisdom OS state: ${path}`);
    return normalizeState(parsed);
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyState();
    throw error;
  }
}

export async function writeState(path, state) {
  const normalized = normalizeState(state);
  await mkdir(dirname(path), { recursive: true });
  const serialized = `${JSON.stringify(normalized, null, 2)}\n`;
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temp, serialized, { encoding: 'utf8', mode: 0o600 });
  await rename(temp, path);
  const landed = await readFile(path, 'utf8');
  if (landed !== serialized) throw new Error(`State verification failed after write: ${path}`);
  return normalized;
}

async function acquire(lockPath, timeoutMs = 5000) {
  const started = Date.now();
  while (true) {
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      return handle;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (Date.now() - started > timeoutMs) throw new Error(`State lock timed out: ${lockPath}`);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 40));
    }
  }
}

export async function updateState(path, mutate) {
  await mkdir(dirname(path), { recursive: true });
  const lockPath = `${path}.lock`;
  const lock = await acquire(lockPath);
  try {
    const before = await readState(path);
    const candidate = await mutate(JSON.parse(JSON.stringify(before)));
    const next = normalizeState(candidate ?? before);
    next.revision = before.revision + 1;
    return await writeState(path, next);
  } finally {
    await lock.close();
    await rm(lockPath, { force: true });
  }
}

export async function ensureState(cwd = process.cwd(), env = process.env) {
  const path = await resolveStatePath(cwd, env);
  try { await stat(path); } catch { await writeState(path, emptyState()); }
  return path;
}
