export const DECISION_STAGES = ['sense', 'distill', 'judge', 'bank', 'learn'];
export const TASK_STAGES = ['backlog', 'ready', 'doing', 'verify', 'done'];

const present = (value) => typeof value === 'string' ? value.trim().length > 0 : value !== undefined && value !== null;
const validRequirement = (value) => typeof value === 'boolean' ? value : present(value);

export function validateDecisionTransition(decision, targetStage) {
  const hasTwoOptions = Array.isArray(decision.options) && decision.options.length >= 2;
  const optionsCarryTradeoffs = hasTwoOptions && decision.options.every((option) => present(option.choice) && present(option.sacrifice));
  const stageRequirements = {
    distill: [
      ['why now', decision.whyNow],
    ],
    judge: [
      ['why now', decision.whyNow],
      ['two options', hasTwoOptions],
      ['option sacrifices', optionsCarryTradeoffs],
    ],
    bank: [
      ['human call', decision.humanCall],
      ['owner', decision.owner],
      ['date', decision.dueDate],
      ['resolved premise', decision.resolvedPremise],
    ],
    learn: [
      ['outcome', decision.outcome],
      ['review', decision.review],
      ['case-law change', decision.caseLawUpdate],
    ],
  };
  const requirements = stageRequirements[targetStage] ?? [];
  const missing = requirements.filter(([, value]) => !validRequirement(value)).map(([label]) => label);
  return { ok: missing.length === 0, missing };
}

export function validateTaskTransition(task, targetStage) {
  const stageRequirements = {
    ready: [
      ['acceptance criteria', task.acceptance],
    ],
    verify: [
      ['maker', task.maker],
      ['evidence', task.evidence],
    ],
    done: [
      ['evidence', task.evidence],
      ['independent verifier', present(task.verifier) && task.verifier.trim() !== task.maker?.trim()],
      ['verification result', task.verification],
      ['human acceptance', task.acceptedByHuman === true],
    ],
  };
  const requirements = stageRequirements[targetStage] ?? [];
  const missing = requirements.filter(([, value]) => !validRequirement(value)).map(([label]) => label);
  return { ok: missing.length === 0, missing };
}

export function moveItem(state, entityType, entityId, target, now = new Date().toISOString()) {
  const collection = entityType === 'decision' ? 'decisions' : 'tasks';
  const index = state[collection].findIndex((item) => item.id === entityId);
  if (index < 0) return { ok: false, missing: ['item'], state };

  const item = state[collection][index];
  const validation = entityType === 'decision'
    ? validateDecisionTransition(item, target.stage)
    : validateTaskTransition(item, target.stage);
  if (!validation.ok) return { ...validation, state };

  const moved = { ...item, ...target, updatedAt: now };
  const nextItems = state[collection].map((entry, itemIndex) => itemIndex === index ? moved : entry);
  const historyEvent = {
    id: `h-${now}-${entityId}`,
    entityType,
    entityId,
    action: 'moved',
    from: { stage: item.stage, areaId: item.areaId },
    to: { stage: moved.stage, areaId: moved.areaId },
    createdAt: now,
  };
  return {
    ok: true,
    missing: [],
    state: { ...state, [collection]: nextItems, history: [...(state.history ?? []), historyEvent] },
  };
}

const priorityRank = { P0: 0, P1: 1, P2: 2, P3: 3 };

export function computeButlerBrief(state, now = new Date().toISOString()) {
  const findings = [];
  const today = now.slice(0, 10);

  for (const decision of state.decisions ?? []) {
    if (decision.priority === 'P0' && !['bank', 'learn'].includes(decision.stage) && !present(decision.humanCall)) {
      findings.push({ type: 'decision-needs-call', entityType: 'decision', entityId: decision.id, title: decision.title, score: 0, priority: decision.priority, message: 'P0 decision is not banked.' });
    }
    if (decision.stage === 'bank' && present(decision.reviewDate) && decision.reviewDate <= today && !present(decision.outcome)) {
      findings.push({ type: 'review-due', entityType: 'decision', entityId: decision.id, title: decision.title, score: 3, priority: decision.priority, message: 'Outcome review is due.' });
    }
  }

  for (const task of state.tasks ?? []) {
    if (task.stage === 'verify' && (!present(task.evidence) || !present(task.verifier))) {
      findings.push({ type: 'task-needs-verification', entityType: 'task', entityId: task.id, title: task.title, score: 1, priority: task.priority, message: 'Handoff lacks evidence or an independent verifier.' });
    }
    if (present(task.blockedReason)) {
      findings.push({ type: 'task-blocked', entityType: 'task', entityId: task.id, title: task.title, score: 2, priority: task.priority, message: task.blockedReason });
    }
  }

  for (const area of state.areas ?? []) {
    if (!present(area.director)) {
      findings.push({ type: 'area-without-director', entityType: 'area', entityId: area.id, title: area.name, score: 4, priority: 'P1', message: 'Area has no accountable Director.' });
    }
  }

  return findings
    .sort((a, b) => a.score - b.score || (priorityRank[a.priority] ?? 9) - (priorityRank[b.priority] ?? 9) || a.title.localeCompare(b.title))
    .slice(0, 3)
    .map(({ score, ...finding }) => finding);
}

export function buildHandoff(state, entityType, entityId) {
  const collection = entityType === 'decision' ? state.decisions : state.tasks;
  const item = (collection ?? []).find((entry) => entry.id === entityId);
  if (!item) return '';
  const decision = entityType === 'decision'
    ? item
    : (state.decisions ?? []).find((entry) => entry.id === item.decisionId);
  const area = (state.areas ?? []).find((entry) => entry.id === item.areaId) ??
    (state.areas ?? []).find((entry) => entry.id === decision?.areaId);
  const openTasks = (state.tasks ?? []).filter((task) => task.stage !== 'done' && (entityType === 'task' ? task.id === entityId : task.decisionId === entityId));
  const ledgerMatches = (entry) => entry.entityType === entityType && entry.entityId === entityId;
  const feedback = (state.feedback ?? []).filter(ledgerMatches).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(-5);
  const runs = (state.runs ?? []).filter(ledgerMatches).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(-5);
  const lines = [
    `# Handoff — ${item.title}`,
    '',
    `Area: ${area?.name ?? 'Unassigned'}`,
    `Director: ${area?.director ?? 'Unassigned'}`,
    `Stage: ${item.stage ?? ''}`,
    `Human call: ${decision?.humanCall ?? ''}`,
    `Owner / date: ${decision?.owner ?? item.owner ?? ''} / ${decision?.dueDate ?? item.dueDate ?? ''}`,
    `Resolved premise: ${decision?.resolvedPremise ?? ''}`,
    '',
    '## Open work',
    ...(openTasks.length ? openTasks.map((task) => `- [${task.stage}] ${task.title} — ${task.acceptance ?? ''}`) : ['- None']),
    '',
    '## Feedback / requirement deltas',
    ...(feedback.length ? feedback.map((entry) => `- ${entry.source ?? 'Unknown'}: ${entry.note ?? ''}${present(entry.requirementDelta) ? ` | Δ ${entry.requirementDelta}` : ''}`) : ['- None']),
    '',
    '## Agent runs / evidence',
    ...(runs.length ? runs.map((entry) => `- ${entry.agent ?? 'Unknown'} · ${entry.command ?? ''} · ${entry.result ?? ''} · ${entry.artifact ?? ''}`) : ['- None']),
  ];
  return lines.join('\n');
}
