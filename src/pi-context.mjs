import { activeContext, retrievePrecedents } from './domain.mjs';

export function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => typeof part?.text === 'string' ? part.text : '').join('\n');
}

export function compact(value, limit = 1200) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

export function topEntity(state) {
  const active = activeContext(state);
  const task = active.tasks[0];
  if (task) return { entityType: 'task', entityId: task.id };
  const decision = active.decisions[0];
  if (decision) return { entityType: 'decision', entityId: decision.id };
  return null;
}

export function contextBlock(state, prompt) {
  const active = activeContext(state);
  const precedents = retrievePrecedents(state, prompt, 3);
  if (!active.decisions.length && !active.tasks.length && !precedents.length) return '';
  const lines = ['# Wisdom OS Core — durable project context'];
  for (const item of active.decisions) lines.push(`- DECISION [${item.stage}] ${item.id}: ${item.title}`);
  for (const item of active.tasks) lines.push(`- TASK [${item.stage}] ${item.id}: ${item.title} — acceptance: ${item.acceptance || 'UNSET'}`);
  if (precedents.length) {
    lines.push('- PRECEDENTS (status is load-bearing; refuted evidence is retained):');
    for (const item of precedents) lines.push(`  - [${item.status}] ${item.id}: ${item.claim} · falsifier: ${item.falsifier || 'UNSET'}`);
  }
  lines.push('Use `wisdom_os` to record a material decision, requirement delta, correction, task, run, or handoff. Never mark BANK/DONE/LEARN on the human\'s behalf.');
  return lines.join('\n');
}
