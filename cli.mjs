#!/usr/bin/env node
import { buildHandoff, moveItem } from './src/domain.mjs';

const baseUrl = (process.env.DECISION_COCKPIT_URL || 'http://127.0.0.1:4178').replace(/\/$/, '');
const [command, ...args] = process.argv.slice(2);

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `${response.status} ${response.statusText}`);
  return payload;
}

async function getState() {
  return request('/api/state');
}

async function putState(state) {
  return request('/api/state', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(state),
  });
}

const usage = () => {
  console.log(`Decision Flywheel Cockpit CLI

Usage:
  node cli.mjs butler
  node cli.mjs list [decision|task]
  node cli.mjs handoff <decision|task> <id>
  node cli.mjs move <decision|task> <id> <stage> [area-id]
  node cli.mjs feedback <decision|task> <id> <source> <note> [requirement-delta]
  node cli.mjs run <decision|task> <id> <agent> <command> <result> [artifact]

Environment:
  DECISION_COCKPIT_URL=http://127.0.0.1:4178`);
};

async function main() {
  if (!command || ['help', '--help', '-h'].includes(command)) return usage();

  if (command === 'butler') {
    const brief = await request('/api/butler/run', { method: 'POST' });
    if (!brief.findings.length) return console.log('SILENT — no P0 judgment needed.');
    for (const finding of brief.findings) {
      console.log(`${finding.priority} ${finding.type} · ${finding.title}\n  ${finding.message}\n  ${finding.entityType}:${finding.entityId}`);
    }
    return;
  }

  if (command === 'list') {
    const type = args[0] === 'task' ? 'task' : 'decision';
    const state = await getState();
    const collection = type === 'decision' ? state.decisions : state.tasks;
    for (const item of collection) console.log(`${item.id}\t${item.stage}\t${item.priority ?? 'P2'}\t${item.title}`);
    return;
  }

  if (command === 'handoff') {
    const [type, id] = args;
    if (!type || !id) throw new Error('handoff requires <decision|task> <id>');
    const handoff = buildHandoff(await getState(), type, id);
    if (!handoff) throw new Error(`Unknown ${type}:${id}`);
    console.log(handoff);
    return;
  }

  if (command === 'move') {
    const [type, id, stage, areaId] = args;
    if (!type || !id || !stage) throw new Error('move requires <decision|task> <id> <stage> [area-id]');
    const state = await getState();
    const collection = type === 'decision' ? state.decisions : state.tasks;
    const item = collection.find((entry) => entry.id === id);
    if (!item) throw new Error(`Unknown ${type}:${id}`);
    const result = moveItem(state, type, id, { stage, areaId: areaId || item.areaId });
    if (!result.ok) throw new Error(`Blocked by gate: ${result.missing.join(', ')}`);
    await putState(result.state);
    console.log(`moved ${type}:${id} -> ${stage} @ ${areaId || item.areaId}`);
    return;
  }

  if (command === 'feedback') {
    const [type, id, source, note, requirementDelta = ''] = args;
    if (!type || !id || !source || !note) throw new Error('feedback requires <type> <id> <source> <note> [requirement-delta]');
    const state = await getState();
    state.feedback.push({ id: `f-${crypto.randomUUID()}`, entityType: type, entityId: id, source, note, requirementDelta, createdAt: new Date().toISOString() });
    await putState(state);
    console.log(`feedback logged for ${type}:${id}`);
    return;
  }

  if (command === 'run') {
    const [type, id, agent, agentCommand, result, artifact = ''] = args;
    if (!type || !id || !agent || !agentCommand || !result) throw new Error('run requires <type> <id> <agent> <command> <result> [artifact]');
    const state = await getState();
    state.runs.push({ id: `r-${crypto.randomUUID()}`, entityType: type, entityId: id, agent, command: agentCommand, result, artifact, createdAt: new Date().toISOString() });
    await putState(state);
    console.log(`agent run logged for ${type}:${id}`);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
