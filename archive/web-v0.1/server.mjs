import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeButlerBrief } from './src/domain.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const EMPTY_STATE = { version: 1, revision: 0, areas: [], decisions: [], tasks: [], feedback: [], runs: [], history: [] };
let stateQueue = Promise.resolve();
const inStateQueue = (operation) => {
  const result = stateQueue.then(operation, operation);
  stateQueue = result.catch(() => {});
  return result;
};
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const sendJson = (res, status, payload) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(payload));
};

async function readState(dataFile) {
  try {
    const state = JSON.parse(await readFile(dataFile, 'utf8'));
    if (!Number.isInteger(state.revision)) state.revision = 0;
    return state;
  } catch (error) {
    if (error.code === 'ENOENT') return structuredClone(EMPTY_STATE);
    throw error;
  }
}

async function writeState(dataFile, state) {
  await mkdir(dirname(dataFile), { recursive: true });
  const serialized = `${JSON.stringify(state, null, 2)}\n`;
  await writeFile(dataFile, serialized, 'utf8');
  const landed = await readFile(dataFile, 'utf8');
  if (landed !== serialized) throw new Error('Shared-state verification failed after write');
  JSON.parse(landed);
}

export async function runButler(dataFile = join(ROOT, 'data', 'board.json')) {
  return inStateQueue(async () => {
    const state = await readState(dataFile);
    const updatedAt = new Date().toISOString();
    state.butler = { updatedAt, findings: computeButlerBrief(state, updatedAt) };
    await writeState(dataFile, state);
    return state.butler;
  });
}

async function readBody(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 5_000_000) throw new Error('Payload too large');
  }
  return JSON.parse(body || '{}');
}

function validState(state) {
  return state && state.version === 1 && ['areas', 'decisions', 'tasks', 'feedback', 'runs', 'history'].every((key) => Array.isArray(state[key]));
}

export function createAppServer({ dataFile = join(ROOT, 'data', 'board.json'), publicRoot = ROOT } = {}) {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/api/health') return sendJson(res, 200, { ok: true, dataFile });
      if (url.pathname === '/api/state' && req.method === 'GET') return sendJson(res, 200, await inStateQueue(() => readState(dataFile)));
      if (url.pathname === '/api/butler/run' && req.method === 'POST') return sendJson(res, 200, await runButler(dataFile));
      if (url.pathname === '/api/state' && req.method === 'PUT') {
        const state = await readBody(req);
        if (!validState(state)) return sendJson(res, 400, { error: 'Invalid board state' });
        const result = await inStateQueue(async () => {
          const current = await readState(dataFile);
          const incomingRevision = Number.isInteger(state.revision) ? state.revision : 0;
          if (incomingRevision !== current.revision) return { conflict: true, revision: current.revision };
          state.revision = current.revision + 1;
          await writeState(dataFile, state);
          return { conflict: false, revision: state.revision };
        });
        if (result.conflict) return sendJson(res, 409, { error: 'Board changed; reload before writing', revision: result.revision });
        return sendJson(res, 200, { ok: true, revision: result.revision });
      }
      if (url.pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'Not found' });

      const requested = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
      const safePath = normalize(requested).replace(/^(\.\.(\/|\\|$))+/, '');
      const filePath = join(publicRoot, safePath);
      const body = await readFile(filePath);
      res.writeHead(200, { 'content-type': MIME[extname(filePath)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
      res.end(body);
    } catch (error) {
      if (error.code === 'ENOENT') return sendJson(res, 404, { error: 'Not found' });
      sendJson(res, 500, { error: error.message });
    }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.PORT || 4178);
  const host = process.env.HOST || '0.0.0.0';
  const dataFile = join(ROOT, 'data', 'board.json');
  const server = createAppServer({ dataFile });
  server.listen(port, host, () => {
    console.log(`Decision Flywheel Cockpit: http://${host}:${port}`);
    console.log(`State: ${dataFile}`);
    runButler(dataFile).catch((error) => console.error(`Butler scan failed: ${error.message}`));
    const timer = setInterval(() => runButler(dataFile).catch((error) => console.error(`Butler scan failed: ${error.message}`)), 60_000);
    timer.unref();
  });
}
