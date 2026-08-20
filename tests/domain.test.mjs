import test from 'node:test';
import assert from 'node:assert/strict';
import { activeContext, buildHandoff, computeButlerBrief, moveItem, recordProcessSignal, retrievePrecedents, validateDecisionTransition, validateImprovementTransition, validateTaskTransition } from '../src/domain.mjs';

test('bank transition names the missing human call, owner, date, and resolved premise', () => {
  const decision = { humanCall: '', owner: '', dueDate: '', resolvedPremise: '' };

  const result = validateDecisionTransition(decision, 'bank');

  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ['human call', 'owner', 'date', 'resolved premise']);
});

test('learn transition requires an outcome, review, and explicit case-law change', () => {
  const decision = { outcome: '', review: '', caseLawUpdate: '' };

  const result = validateDecisionTransition(decision, 'learn');

  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ['outcome', 'review', 'case-law change']);
});

test('done transition requires independent verification, evidence, and human acceptance', () => {
  const task = { acceptance: 'Pi TUI flow works', evidence: '', maker: 'Pi-maker', verifier: 'Pi-maker', verification: '', acceptedByHuman: false };

  const result = validateTaskTransition(task, 'done');

  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ['evidence', 'independent verifier', 'verification result', 'human acceptance']);
});

test('judge transition requires why-now plus two real options with sacrifices', () => {
  const decision = { whyNow: '', options: [{ choice: 'A', sacrifice: '' }] };

  const result = validateDecisionTransition(decision, 'judge');

  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ['why now', 'two options', 'option sacrifices']);
});

test('ready and verify transitions expose missing acceptance and execution evidence', () => {
  assert.deepEqual(validateTaskTransition({ acceptance: '' }, 'ready').missing, ['acceptance criteria']);
  assert.deepEqual(validateTaskTransition({ maker: '', evidence: '' }, 'verify').missing, ['maker', 'evidence']);
});

test('moving an item can change director area and appends an immutable history event', () => {
  const state = {
    decisions: [{ id: 'd1', title: 'Choose board shape', stage: 'sense', areaId: 'a1', whyNow: 'The workflow is fragmenting across agents.' }],
    tasks: [],
    history: [],
  };

  const result = moveItem(state, 'decision', 'd1', { stage: 'distill', areaId: 'a2' }, '2026-08-16T11:00:00.000Z');

  assert.equal(result.ok, true);
  assert.equal(result.state.decisions[0].stage, 'distill');
  assert.equal(result.state.decisions[0].areaId, 'a2');
  assert.equal(state.decisions[0].stage, 'sense');
  assert.deepEqual(result.state.history[0], {
    id: 'h-2026-08-16T11:00:00.000Z-d1',
    entityType: 'decision',
    entityId: 'd1',
    action: 'moved',
    from: { stage: 'sense', areaId: 'a1' },
    to: { stage: 'distill', areaId: 'a2' },
    createdAt: '2026-08-16T11:00:00.000Z',
  });
});

test('butler absorbs noise and returns at most three ranked findings', () => {
  const state = {
    areas: [
      { id: 'a1', name: 'Product', director: '' },
      { id: 'a2', name: 'Delivery', director: 'DIR-delivery' },
    ],
    decisions: [
      { id: 'd1', title: 'Pick wedge', stage: 'judge', priority: 'P0', humanCall: '', areaId: 'a1' },
      { id: 'd2', title: 'Old bet', stage: 'bank', priority: 'P1', reviewDate: '2026-08-10', outcome: '', areaId: 'a2', owner: 'Human', dueDate: '2026-08-01' },
    ],
    tasks: [
      { id: 't1', title: 'Ship demo', stage: 'verify', priority: 'P0', evidence: '', verifier: '', areaId: 'a2' },
      { id: 't2', title: 'Blocked dependency', stage: 'ready', priority: 'P1', blockedReason: 'Need access', areaId: 'a2' },
    ],
  };

  const findings = computeButlerBrief(state, '2026-08-16T12:00:00.000Z');

  assert.equal(findings.length, 3);
  assert.equal(findings[0].type, 'decision-needs-call');
  assert.equal(findings[0].entityId, 'd1');
  assert.ok(findings.some((finding) => finding.type === 'task-needs-verification'));
});

test('handoff packages decision, director, open work, feedback, and agent-run evidence', () => {
  const state = {
    areas: [{ id: 'a1', name: 'Product', director: 'DIR-product', mandate: 'Close the product loop' }],
    decisions: [{ id: 'd1', title: 'Pick wedge', areaId: 'a1', stage: 'bank', humanCall: 'Context-first', owner: 'Human', dueDate: '2026-08-20', resolvedPremise: 'Continuity compounds' }],
    tasks: [{ id: 't1', title: 'Build Pi TUI MVP', decisionId: 'd1', stage: 'doing', acceptance: 'State restores in a fresh Pi session' }],
    feedback: [{ id: 'f1', entityType: 'decision', entityId: 'd1', source: 'Human', note: 'Add a Butler', requirementDelta: 'Global scan required', createdAt: '2026-08-16T10:00:00.000Z' }],
    runs: [{ id: 'r1', entityType: 'decision', entityId: 'd1', agent: 'Claude Code', command: 'npm test', result: 'pass', artifact: 'test.log', createdAt: '2026-08-16T11:00:00.000Z' }],
  };

  const handoff = buildHandoff(state, 'decision', 'd1');

  assert.match(handoff, /Pick wedge/);
  assert.match(handoff, /DIR-product/);
  assert.match(handoff, /Build Pi TUI MVP/);
  assert.match(handoff, /Global scan required/);
  assert.match(handoff, /Claude Code · npm test · pass · test.log/);
});

test('a recurring correction opens governed harness work without silently approving semantics', () => {
  const base = { tasks: [], processSignals: [], improvements: [] };
  const once = recordProcessSignal(base, { id: 's1', klass: 'missing-source', semantic: true });
  assert.equal(once.improvements.length, 0);
  const twice = recordProcessSignal(once, { id: 's2', klass: 'missing-source', semantic: true });
  assert.equal(twice.improvements.length, 1);
  assert.equal(twice.improvements[0].needsHumanApproval, true);
  assert.equal(twice.tasks.length, 0);
  assert.deepEqual(validateImprovementTransition(twice.improvements[0], 'canary').missing,
    ['regression test', 'rollback', 'quality auto-disable', 'human approval when semantic']);

  const mechanical1 = recordProcessSignal(twice, { id: 'm1', klass: 'duplicate-write', semantic: false });
  const mechanical2 = recordProcessSignal(mechanical1, { id: 'm2', klass: 'duplicate-write', semantic: false });
  assert.equal(mechanical2.improvements.at(-1).needsHumanApproval, false);
  assert.equal(mechanical2.tasks.at(-1).improvementId, 'improvement-duplicate-write');
});

test('precedent retrieval keeps refuted cases visible and active context stays bounded', () => {
  const state = {
    decisions: [
      { id: 'd0', title: 'P0 call', stage: 'judge', priority: 'P0' },
      { id: 'd1', title: 'P1 call', stage: 'sense', priority: 'P1' },
      { id: 'd2', title: 'Learned call', stage: 'learn', priority: 'P0' },
    ],
    tasks: Array.from({ length: 7 }, (_, i) => ({ id: `t${i}`, title: `Task ${i}`, stage: i === 6 ? 'done' : 'ready', priority: i ? 'P1' : 'P0' })),
    cases: [
      { id: 'c-active', claim: 'Video supply is thin on clips', status: 'active', scope: { surface: 'clips' }, falsifier: 'supply parity' },
      { id: 'c-refuted', claim: 'Video supply is always thin', status: 'refuted', scope: { surface: 'clips' }, observedOutcome: 'feed was thick', falsifier: 'none' },
    ],
  };

  const hits = retrievePrecedents(state, 'clips video supply', 5);
  assert.deepEqual(hits.map((hit) => hit.id), ['c-refuted', 'c-active']);
  assert.equal(activeContext(state).decisions.length, 2);
  assert.equal(activeContext(state).tasks.length, 5);
});
