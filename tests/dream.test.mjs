import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyQualityVerdict, canApply, coalesce, coalesceKey, DREAM_DEFAULTS, emit, emptyDream,
  makeProposal, PRODUCED_BY, PROPOSAL_VERBS, propose, qualityVerdict, reachesHumanSurface,
  selectEvents, shouldRun,
} from '../src/dream.mjs';
import { emptyState, normalizeState } from '../src/store.mjs';

const NOW = '2026-08-22T12:00:00.000Z';
const OLD = '2026-06-01T00:00:00.000Z';
const full = (over = {}) => ({ landing: 'l', proof: 'p', cost: 'c', falsifier: 'f', rollback: 'r',
  autoDisable: 'a', evidenceIds: ['e1'], maker: 'm', verifier: 'v', needsHumanApproval: false, ...over });

// ── triggers are bounded ─────────────────────────────────────────────────────────────────────

test('every trigger is bounded and every refusal explains itself', () => {
  const idle = shouldRun(emptyDream(), { now: NOW });
  assert.equal(idle.run, false);
  assert.match(idle.reason, /no trigger: 0\/20 turns/);

  const bySession = shouldRun({ ...emptyDream(), cursor: { turns: 20, lastRunAt: '', runsThisSession: 0 } }, { now: NOW });
  assert.equal(bySession.trigger, 'session');

  const byCorrection = shouldRun(emptyDream(), { now: NOW, pendingCorrections: 2 });
  assert.equal(byCorrection.trigger, 'correction-failure');

  // The time floor beats a satisfied session count — otherwise the loop runs hot.
  const tooSoon = shouldRun({ ...emptyDream(), cursor: { turns: 500, lastRunAt: '2026-08-22T11:30:00.000Z', runsThisSession: 1 } },
    { now: NOW });
  assert.equal(tooSoon.run, false);
  assert.match(tooSoon.reason, /time floor: 30m of 60m/);

  const ceiling = shouldRun({ ...emptyDream(), cursor: { turns: 999, lastRunAt: '', runsThisSession: DREAM_DEFAULTS.maxRunsPerSession } },
    { now: NOW });
  assert.equal(ceiling.run, false);
  assert.match(ceiling.reason, /session ceiling/);

  const off = shouldRun({ ...emptyDream(), disabled: true, disabledReason: 'quality' }, { now: NOW, pendingCorrections: 99 });
  assert.equal(off.run, false, 'a disabled loop must not be re-armed by a loud trigger');
});

// ── scar 1: it must be able to RETIRE, not only add ──────────────────────────────────────────

test('retire and refute are first-class verbs with their own evidence paths', () => {
  assert.deepEqual(PROPOSAL_VERBS, ['add', 'amend', 'retire', 'refute']);

  // refute — the belief's own falsifier was observed.
  const refuted = propose({ now: NOW, signals: [], precedentUses: [],
    cases: [{ id: 'case-a', status: 'active', falsifier: 'rate does not fall', falsifierObserved: 'obs-1' }] });
  assert.equal(refuted.length, 1);
  assert.equal(refuted[0].verb, 'refute');
  assert.match(refuted[0].landing, /retain it as negative precedent/);

  // retire — absence of use, past review. The verb the private loop never once reached.
  const retired = propose({ now: NOW, signals: [], precedentUses: [],
    cases: [{ id: 'case-b', status: 'active', reviewDate: OLD }] });
  assert.equal(retired.length, 1);
  assert.equal(retired[0].verb, 'retire');
  assert.match(retired[0].proof, /the evidence is the absence/);
  assert.match(retired[0].rollback, /nothing was deleted/);

  // A case that IS being used is not retired for being old.
  const used = propose({ now: NOW, signals: [], cases: [{ id: 'case-b', status: 'active', reviewDate: OLD }],
    precedentUses: [{ caseId: 'case-b', at: '2026-08-20T00:00:00.000Z' }] });
  assert.deepEqual(used, [], 'recent use must protect a belief from retirement');

  // amend — observed diverges from expected.
  const amended = propose({ now: NOW, signals: [], precedentUses: [],
    cases: [{ id: 'case-c', status: 'active', expectedOutcome: 'x', observedOutcome: 'y' }] });
  assert.equal(amended[0].verb, 'amend');

  // add — a recurring class no case covers.
  const added = propose({ now: NOW, cases: [], precedentUses: [],
    signals: [{ id: 's1', klass: 'wrong-scope' }, { id: 's2', klass: 'wrong-scope' }] });
  assert.equal(added[0].verb, 'add');
  assert.deepEqual(added[0].evidenceIds, ['s1', 's2']);

  // One occurrence is not a class, and a covered class is not re-proposed.
  assert.deepEqual(propose({ now: NOW, cases: [], precedentUses: [], signals: [{ id: 's1', klass: 'wrong-scope' }] }), []);
  assert.deepEqual(propose({ now: NOW, precedentUses: [], cases: [{ id: 'wrong-scope', status: 'active' }],
    signals: [{ id: 's1', klass: 'wrong-scope' }, { id: 's2', klass: 'wrong-scope' }] }), []);
});

test('a refuted belief is never proposed again, and output is capped per run', () => {
  const alreadyDead = propose({ now: NOW, signals: [], precedentUses: [],
    cases: [{ id: 'case-a', status: 'refuted', reviewDate: OLD, falsifier: 'f', falsifierObserved: 'o' }] });
  assert.deepEqual(alreadyDead, []);

  const many = propose({ now: NOW, signals: [], precedentUses: [],
    cases: Array.from({ length: 12 }, (_, i) => ({ id: `case-${i}`, status: 'active', reviewDate: OLD })) });
  assert.equal(many.length, DREAM_DEFAULTS.maxProposalsPerRun, 'P0 or silence — a batch is a new inbox');
});

// ── scar 3: the coalescer must not eat its own output ────────────────────────────────────────

test('the loop never reads what the loop wrote', () => {
  const state = {
    processSignals: [{ id: 's1', klass: 'real' }, { id: 's2', klass: 'real' },
      { id: 'mine', klass: 'echo', producedBy: PRODUCED_BY }],
    events: [{ id: 'e1' }, { id: 'e2', producedBy: PRODUCED_BY }],
    cases: [{ id: 'c1' }, { id: 'c2', producedBy: PRODUCED_BY }],
  };
  const input = selectEvents(state);
  assert.deepEqual(input.signals.map((row) => row.id), ['s1', 's2']);
  assert.deepEqual(input.events.map((row) => row.id), ['e1']);
  assert.deepEqual(input.cases.map((row) => row.id), ['c1']);

  // End to end: emit a proposal, then re-read. The emitted proposal must not become evidence.
  const emitted = emit(emptyState(), { trigger: 'session', now: NOW,
    proposals: [makeProposal({ verb: 'add', subject: 'k', now: NOW, ...full() })] });
  const second = selectEvents(emitted);
  assert.equal(second.signals.length, 0, 'an emitted proposal must not re-enter as an input signal');
});

test('duplicates coalesce within a batch and against what is already open', () => {
  const a = makeProposal({ verb: 'add', subject: 'k', evidenceIds: ['s1'], now: NOW, ...full({ evidenceIds: ['s1'] }) });
  const b = makeProposal({ verb: 'add', subject: 'k', evidenceIds: ['s2'], now: NOW, ...full({ evidenceIds: ['s2'] }) });
  const batch = coalesce([a, b], []);
  assert.equal(batch.fresh.length, 1, 'one subject, one proposal');
  assert.deepEqual(batch.fresh[0].evidenceIds, ['s1', 's2'], 'evidence is unioned, not dropped');

  const openAlready = coalesce([b], [{ ...a, verb: 'add', subject: 'k' }]);
  assert.equal(openAlready.fresh.length, 0, 'an already-open proposal is strengthened, not duplicated');
  assert.deepEqual(openAlready.strengthened[0].evidenceIds, ['s1', 's2']);

  // A disabled proposal must not suppress a fresh one forever.
  assert.equal(coalesce([a], [{ ...a, stage: 'disabled' }]).fresh.length, 1);
  // Different verbs on the same subject are different proposals.
  const retire = makeProposal({ verb: 'retire', subject: 'k', now: NOW, ...full() });
  assert.notEqual(coalesceKey(a), coalesceKey(retire));
});

// ── scar 2: an emitted proposal must reach a surface a human opens ───────────────────────────

test('an emitted proposal appears in the Butler brief a human actually reads', () => {
  const proposal = makeProposal({ verb: 'retire', subject: 'case-b', semantic: true, now: NOW, ...full({ needsHumanApproval: true }) });
  const after = emit(emptyState(), { trigger: 'session', proposals: [proposal], now: NOW });
  assert.equal(reachesHumanSurface(after, proposal.id, NOW), true,
    'a proposal nobody can see is a detector with zero callers, not a loop');
  assert.equal(reachesHumanSurface(emptyState(), proposal.id, NOW), false, 'the check must be able to fail');
});

// ── the application gate is a gate, not a comment ────────────────────────────────────────────

test('a semantic proposal cannot self-apply', () => {
  const semantic = makeProposal({ verb: 'amend', subject: 'case-c', semantic: true, now: NOW, ...full({ needsHumanApproval: true }) });
  const blocked = canApply(semantic);
  assert.equal(blocked.ok, false);
  assert.deepEqual(blocked.missing, ['human approval for a semantic change']);
  assert.equal(canApply({ ...semantic, approvedByHuman: true }).ok, true);
});

test('nothing applies without LANDING, PROOF, COST, falsifier, rollback, auto-disable and an independent verifier', () => {
  const base = makeProposal({ verb: 'add', subject: 'k', semantic: false, now: NOW, ...full() });
  assert.equal(canApply(base).ok, true);
  for (const [field, label] of [['landing', 'landing'], ['proof', 'proof'], ['cost', 'cost'],
    ['falsifier', 'falsifier'], ['rollback', 'rollback'], ['autoDisable', 'quality auto-disable']]) {
    assert.deepEqual(canApply({ ...base, [field]: '' }).missing, [label], `${field} must be required`);
  }
  assert.deepEqual(canApply({ ...base, verifier: '' }).missing, ['independent verifier']);
  assert.deepEqual(canApply({ ...base, verifier: 'm' }).missing, ['verifier distinct from maker']);
  assert.deepEqual(canApply({ ...base, evidenceIds: [] }).missing, ['evidence']);
  // Retirement is the one verb whose evidence IS an absence, so it is not required to cite an id.
  assert.equal(canApply({ ...base, verb: 'retire', evidenceIds: [] }).ok, true);
});

// ── auto-disable must be able to fire ────────────────────────────────────────────────────────

test('the loop disables itself when humans keep rejecting what it proposes', () => {
  const runs = Array.from({ length: 3 }, (_, i) => ({ id: `run-${i}` }));
  const proposal = (i, stage) => ({ id: `p${i}`, producedBy: PRODUCED_BY, stage });

  const healthy = { dream: { ...emptyDream(), runs },
    improvements: [proposal(1, 'proposed'), proposal(2, 'proposed'), proposal(3, 'disabled')] };
  assert.equal(qualityVerdict(healthy).disable, false);

  const rejected = { dream: { ...emptyDream(), runs },
    improvements: [proposal(1, 'disabled'), proposal(2, 'disabled'), proposal(3, 'proposed')] };
  const verdict = qualityVerdict(rejected);
  assert.equal(verdict.disable, true, 'a 67% rejection rate must trip the auto-disable');
  assert.match(verdict.reason, /humans disabled 2\/3/);

  const off = applyQualityVerdict(rejected, verdict);
  assert.equal(off.dream.disabled, true);
  assert.match(off.dream.disabledReason, /67%/);

  // It will not judge itself on too little evidence, and human proposals are not counted against it.
  assert.equal(qualityVerdict({ dream: { ...emptyDream(), runs: [{ id: 'r' }] }, improvements: [] }).disable, false);
  assert.equal(qualityVerdict({ dream: { ...emptyDream(), runs },
    improvements: [{ id: 'h1', stage: 'disabled' }, { id: 'h2', stage: 'disabled' }] }).disable, false,
    'proposals the loop did not produce must not disable it');
});

test('an auto-disabled loop stays disabled across a restart', () => {
  const written = { ...emptyState(), dream: { ...emptyDream(), disabled: true, disabledReason: 'quality' } };
  const reloaded = normalizeState(JSON.parse(JSON.stringify(written)));
  assert.equal(reloaded.dream.disabled, true, 'a kill switch a reload clears is a pause, not a kill switch');
  assert.equal(reloaded.dream.disabledReason, 'quality');
  // A fresh state has the loop live and the journal empty.
  assert.equal(normalizeState({}).dream.disabled, false);
  assert.deepEqual(normalizeState({}).dream.runs, []);
});

test('the run journal is bounded and records which trigger fired', () => {
  let state = emptyState();
  for (let i = 0; i < 5; i += 1) {
    state = emit(state, { trigger: 'session', proposals: [], now: `2026-08-22T12:0${i}:00.000Z`,
      bounds: { ...DREAM_DEFAULTS, maxJournalRuns: 3 } });
  }
  assert.equal(state.dream.runs.length, 3, 'the journal is bounded');
  assert.equal(state.dream.runs.at(-1).trigger, 'session');
  assert.equal(state.dream.cursor.runsThisSession, 5);
  assert.equal(state.dream.cursor.turns, 0, 'a run resets the turn counter');
});

test('an unknown verb or an unnamed subject is refused rather than keyed as undefined', () => {
  assert.throws(() => makeProposal({ verb: 'improve', subject: 'x', now: NOW }), /unknown proposal verb/);
  assert.throws(() => makeProposal({ verb: 'add', subject: '', now: NOW }), /must name its subject/);
});
