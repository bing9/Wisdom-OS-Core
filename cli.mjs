#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { buildHandoff, computeButlerBrief, moveItem, retrievePrecedents } from './src/domain.mjs';
import { ensureState, readState, resolveStatePath, updateState } from './src/store.mjs';

const [command, ...args] = process.argv.slice(2);
const cwd = process.cwd();
const statePath = await ensureState(cwd);

const usage = () => {
  console.log(`Wisdom OS Core CLI (direct local state; no server required)

Usage:
  node cli.mjs init
  node cli.mjs butler
  node cli.mjs list [decision|task|case]
  node cli.mjs handoff <decision|task> <id>
  node cli.mjs move <decision|task> <id> <stage> [area-id]
  node cli.mjs feedback <decision|task> <id> <source> <note> [requirement-delta]
  node cli.mjs run <decision|task> <id> <agent> <command> <result> [artifact]
  node cli.mjs precedents <query>

State:
  WISDOM_OS_STATE=/absolute/path/state.json overrides the private project default.`);
};

async function main() {
  if (!command || ['help', '--help', '-h'].includes(command)) return usage();

  if (command === 'init') {
    console.log(await resolveStatePath(cwd));
    return;
  }

  if (command === 'butler') {
    const findings = computeButlerBrief(await readState(statePath));
    if (!findings.length) return console.log('SILENT — no P0 judgment needed.');
    for (const finding of findings) {
      console.log(`${finding.priority} ${finding.type} · ${finding.title}\n  ${finding.message}\n  ${finding.entityType}:${finding.entityId}`);
    }
    return;
  }

  if (command === 'list') {
    const type = ['task', 'case'].includes(args[0]) ? args[0] : 'decision';
    const state = await readState(statePath);
    const collection = type === 'decision' ? state.decisions : type === 'task' ? state.tasks : state.cases;
    for (const item of collection) {
      console.log(`${item.id}\t${item.stage ?? item.status ?? ''}\t${item.priority ?? ''}\t${item.title ?? item.claim ?? ''}`);
    }
    return;
  }

  if (command === 'handoff') {
    const [type, id] = args;
    if (!type || !id) throw new Error('handoff requires <decision|task> <id>');
    const handoff = buildHandoff(await readState(statePath), type, id);
    if (!handoff) throw new Error(`Unknown ${type}:${id}`);
    console.log(handoff);
    return;
  }

  if (command === 'move') {
    const [type, id, stage, areaId] = args;
    if (!type || !id || !stage) throw new Error('move requires <decision|task> <id> <stage> [area-id]');
    let moved;
    await updateState(statePath, (state) => {
      const collection = type === 'decision' ? state.decisions : state.tasks;
      const item = collection.find((entry) => entry.id === id);
      if (!item) throw new Error(`Unknown ${type}:${id}`);
      moved = moveItem(state, type, id, { stage, areaId: areaId || item.areaId });
      if (!moved.ok) throw new Error(`Blocked by gate: ${moved.missing.join(', ')}`);
      return moved.state;
    });
    console.log(`moved ${type}:${id} -> ${stage}`);
    return;
  }

  if (command === 'feedback') {
    const [type, id, source, note, requirementDelta = ''] = args;
    if (!type || !id || !source || !note) throw new Error('feedback requires <type> <id> <source> <note> [requirement-delta]');
    await updateState(statePath, (state) => {
      state.feedback.push({ id: `f-${randomUUID()}`, entityType: type, entityId: id, source,
        note, requirementDelta, createdAt: new Date().toISOString() });
      return state;
    });
    console.log(`feedback logged for ${type}:${id}`);
    return;
  }

  if (command === 'run') {
    const [type, id, agent, agentCommand, result, artifact = ''] = args;
    if (!type || !id || !agent || !agentCommand || !result) throw new Error('run requires <type> <id> <agent> <command> <result> [artifact]');
    await updateState(statePath, (state) => {
      state.runs.push({ id: `r-${randomUUID()}`, entityType: type, entityId: id, agent,
        command: agentCommand, result, artifact, createdAt: new Date().toISOString() });
      return state;
    });
    console.log(`agent run logged for ${type}:${id}`);
    return;
  }

  if (command === 'precedents') {
    const query = args.join(' ').trim();
    if (!query) throw new Error('precedents requires a query');
    const hits = retrievePrecedents(await readState(statePath), query, 5);
    if (!hits.length) return console.log('No matching precedents in this state root.');
    for (const hit of hits) console.log(`${hit.status}\t${hit.id}\t${hit.claim}\t${hit.score.toFixed(2)}`);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
