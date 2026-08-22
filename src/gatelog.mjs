// Ported from the production `wos-guards.ts` extension (private harness).
// Preserved: the gate manifest that never re-dates an existing gate, gate-hit telemetry carrying
// real-vs-synthetic provenance, and the coverage question "which gates have only ever fired on a
// synthetic path".
// Stripped: private state paths, private gate ids, private session identifiers.
//
// A gate count is not evidence. `installed` and `working` must never share one word.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { appendFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const MAX_GATE_EVENTS = 2000;

/**
 * Build the manifest of declared gates.
 *
 * `shipped` is carried over from the previous manifest whenever the gate id already exists, so a
 * redeploy can never re-date an old gate and make a long-standing control look new. A gate dropped
 * from `gates` is retained under `retired` rather than vanishing — a gate that disappears silently
 * takes its history with it.
 */
export function gateManifest(gates, previous = {}, now = new Date().toISOString()) {
  const prior = previous.gates ?? {};
  const out = { updated: now, gates: {}, retired: { ...(previous.retired ?? {}) } };
  for (const gate of gates) {
    if (!gate?.id) throw new Error('gateManifest: every gate needs an id');
    out.gates[gate.id] = {
      hook: gate.hook ?? '',
      shipped: prior[gate.id]?.shipped ?? gate.shipped ?? now.slice(0, 10),
    };
    delete out.retired[gate.id];
  }
  for (const [id, entry] of Object.entries(prior)) {
    if (!out.gates[id]) out.retired[id] = { ...entry, retiredAt: out.retired[id]?.retiredAt ?? now };
  }
  return out;
}

export async function writeManifest(path, gates, now = new Date().toISOString()) {
  let previous = {};
  try { previous = JSON.parse(await readFile(path, 'utf8')); } catch { /* first write */ }
  const manifest = gateManifest(gates, previous, now);
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}`;
  await writeFile(temp, serialized, 'utf8');
  await rename(temp, path);
  return manifest;
}

/**
 * One gate hit.
 *
 * `caughtBy` is the field that makes the ratio computable: a gate that only ever reports
 * `caughtBy: 'gate'` has not yet been shown to beat the human who would otherwise have caught it.
 * `synthetic` records whether the firing path was a test. Without it, a suite that proves the gate
 * compiles reads identically to evidence that it fires in production.
 */
export function gateEvent({ gateId, detail = '', command = '', caughtBy = 'gate', synthetic = false,
  now = new Date().toISOString() }) {
  if (!gateId) throw new Error('gateEvent: gateId is required');
  return {
    ts: now,
    gateId,
    caughtBy,
    synthetic: synthetic === true,
    detail: String(detail).slice(0, 200),
    command: String(command).slice(0, 200),
  };
}

/** Append-only journal. Never throws into the caller's turn; returns false when it could not write. */
export async function logGate(path, event) {
  try {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(event)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

export function parseGateEvents(body, limit = MAX_GATE_EVENTS) {
  const rows = [];
  for (const line of String(body ?? '').split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* a corrupt line is not a reason to lose the rest */ }
  }
  return rows.slice(-limit);
}

/**
 * The honesty report. For every declared gate:
 *   never    — declared, no recorded hit at all
 *   synthetic-only — it compiles and fires in tests; unproven on a real path
 *   live     — it has fired outside a test
 *
 * `syntheticOnly` is the list that must not be described as working.
 */
export function gateCoverage(manifest, events) {
  const declared = Object.keys(manifest?.gates ?? {});
  const status = {};
  for (const id of declared) {
    const hits = events.filter((event) => event.gateId === id);
    status[id] = hits.length === 0
      ? 'never'
      : hits.some((event) => event.synthetic !== true) ? 'live' : 'synthetic-only';
  }
  const undeclared = [...new Set(events.map((event) => event.gateId))].filter((id) => id && !declared.includes(id));
  return {
    declared: declared.length,
    status,
    never: declared.filter((id) => status[id] === 'never'),
    syntheticOnly: declared.filter((id) => status[id] === 'synthetic-only'),
    live: declared.filter((id) => status[id] === 'live'),
    undeclared,
  };
}
