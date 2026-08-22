// A53-c9/c10 — the continuous-improvement ("dream") loop, as a mechanism with no content.
//
// Core ships the LOOP. The private harness keeps the BELIEFS. Nothing here encodes what is true,
// only how a claim earns amendment, retirement or refutation from evidence.
//
// ── the three scars this loop already carries ────────────────────────────────────────────────
//
// 1. IT COMPOUNDED IN ONE DIRECTION. In the private harness: 55 proposals accepted, 0 beliefs ever
//    retired. A loop that can only add makes its owner more self-consistent, never more correct.
//    So `retire` and `refute` are first-class verbs with their OWN evidence paths — retirement is
//    earned by absence of use, refutation by a fired falsifier — not a branch of `amend`.
//
// 2. A DETECTOR WITH ZERO CALLERS IS NOT A LOOP. Proposals are written into `state.improvements`,
//    the same collection `computeButlerBrief` already surfaces, so an emitted proposal lands on a
//    surface a human actually opens. Emitting into a private directory would have the shape of a
//    learning loop and none of its function.
//
// 3. THE COALESCER WILL MATCH ITS OWN OUTPUT. This loop reads text it also writes. Every record it
//    emits is stamped `producedBy: 'dream'` and `selectEvents` excludes those stamps, so a proposal
//    can never re-enter as evidence for itself.

import { computeButlerBrief } from './domain.mjs';

export const PROPOSAL_VERBS = ['add', 'amend', 'retire', 'refute'];
export const PRODUCED_BY = 'dream';

/** Every bound is explicit and numeric. An unbounded background loop is a runaway with a schedule. */
export const DREAM_DEFAULTS = {
  turnsPerRun: 20,          // session trigger: settled turns between runs
  minMinutesBetweenRuns: 60, // time trigger: wall-clock floor between runs
  correctionThreshold: 2,   // correction-failure trigger: same class seen this many times
  maxRunsPerSession: 8,     // hard ceiling; the loop stops itself rather than idling hot
  maxProposalsPerRun: 3,    // P0 or silence — a batch of ten is a new inbox, not a finding
  maxJournalRuns: 200,      // bounded journal
  eventWindow: 500,         // most recent durable events considered
  staleReviewDays: 30,      // a belief unused this long past review is a retirement candidate
  rejectionRateLimit: 0.6,  // auto-disable: proportion of proposals a human disabled
  minRunsBeforeQualityCheck: 3,
};

export const emptyDream = () => ({ runs: [], disabled: false, disabledReason: '', cursor: { turns: 0, lastRunAt: '', runsThisSession: 0 } });

const present = (value) => typeof value === 'string' ? value.trim().length > 0 : value !== undefined && value !== null;
const days = (from, to) => (Date.parse(to) - Date.parse(from)) / 86_400_000;

// ── triggers ─────────────────────────────────────────────────────────────────────────────────

/**
 * Decide whether to run, and say which bound authorised it. Returns a reason either way — a loop
 * that cannot explain why it did not run is indistinguishable from one that is broken.
 */
export function shouldRun(dream = emptyDream(), { now, pendingCorrections = 0, bounds = DREAM_DEFAULTS } = {}) {
  if (dream.disabled) return { run: false, trigger: null, reason: `disabled: ${dream.disabledReason || 'unstated'}` };
  const cursor = dream.cursor ?? emptyDream().cursor;
  if (cursor.runsThisSession >= bounds.maxRunsPerSession) {
    return { run: false, trigger: null, reason: `session ceiling reached (${bounds.maxRunsPerSession})` };
  }
  const sinceMinutes = cursor.lastRunAt ? (Date.parse(now) - Date.parse(cursor.lastRunAt)) / 60_000 : Infinity;
  if (sinceMinutes < bounds.minMinutesBetweenRuns) {
    return { run: false, trigger: null, reason: `time floor: ${Math.round(sinceMinutes)}m of ${bounds.minMinutesBetweenRuns}m` };
  }
  if (pendingCorrections >= bounds.correctionThreshold) {
    return { run: true, trigger: 'correction-failure', reason: `${pendingCorrections} corrections ≥ ${bounds.correctionThreshold}` };
  }
  if (cursor.turns >= bounds.turnsPerRun) {
    return { run: true, trigger: 'session', reason: `${cursor.turns} turns ≥ ${bounds.turnsPerRun}` };
  }
  return { run: false, trigger: null, reason: `no trigger: ${cursor.turns}/${bounds.turnsPerRun} turns, ${pendingCorrections}/${bounds.correctionThreshold} corrections` };
}

// ── evidence selection ───────────────────────────────────────────────────────────────────────

/**
 * The input set. Anything this loop produced is excluded — scar 3. Without this the coalescer
 * matches its own output and the loop measures itself into a trend.
 */
export function selectEvents(state = {}, bounds = DREAM_DEFAULTS) {
  const mine = (row) => row?.producedBy === PRODUCED_BY;
  return {
    signals: (state.processSignals ?? []).filter((row) => !mine(row)).slice(-bounds.eventWindow),
    events: (state.events ?? []).filter((row) => !mine(row)).slice(-bounds.eventWindow),
    cases: (state.cases ?? []).filter((row) => !mine(row)),
    precedentUses: state.precedentUses ?? [],
    existing: (state.improvements ?? []),
  };
}

// ── proposal construction ────────────────────────────────────────────────────────────────────

/**
 * Every proposal carries LANDING / PROOF / COST plus falsifier, rollback, auto-disable and a named
 * independent verifier. A proposal missing any of them cannot be applied — see `canApply`.
 */
export function makeProposal({ verb, subject, klass, evidenceIds = [], landing, proof, cost,
  falsifier, rollback, autoDisable, semantic = true, maker = '', verifier = '', now }) {
  if (!PROPOSAL_VERBS.includes(verb)) throw new Error(`unknown proposal verb: ${verb}`);
  if (!present(subject)) throw new Error('a proposal must name its subject');
  return {
    id: `dream-${verb}-${String(subject).replace(/[^a-z0-9-]+/gi, '-').toLowerCase()}`,
    producedBy: PRODUCED_BY,
    verb, subject, klass: klass ?? subject,
    title: `${verb} ${subject}`,
    stage: 'proposed', priority: 'P1',
    evidenceIds, landing, proof, cost, falsifier, rollback, autoDisable,
    semantic, needsHumanApproval: semantic !== false, approvedByHuman: false,
    maker, verifier, verification: '', canaryResult: '',
    expectedEffect: proof, regressionTest: '',
    createdAt: now, updatedAt: now,
  };
}

/**
 * Derive proposals from evidence. Four verbs, four DISTINCT evidence paths.
 *
 * add     — a recurring correction class no belief covers yet
 * amend   — a belief whose observed outcome diverges from what it expected
 * retire  — a belief past review that nothing has used: absence of use, named as such
 * refute  — a belief whose own falsifier has been observed to fire
 */
export function propose({ signals = [], cases = [], precedentUses = [], now, bounds = DREAM_DEFAULTS }) {
  const out = [];

  const byClass = new Map();
  for (const signal of signals) {
    const key = String(signal?.klass ?? '');
    if (!key) continue;
    byClass.set(key, [...(byClass.get(key) ?? []), signal]);
  }
  const covered = new Set(cases.flatMap((item) => [item.klass, item.id].filter(Boolean)));
  for (const [klass, group] of byClass) {
    if (group.length < bounds.correctionThreshold || covered.has(klass)) continue;
    out.push(makeProposal({
      verb: 'add', subject: klass, klass, evidenceIds: group.map((row) => row.id).filter(Boolean),
      landing: `Open a case for the recurring class "${klass}".`,
      proof: `Occurrences of "${klass}" fall after the case is in retrieval.`,
      cost: `One more precedent in every retrieval for this class.`,
      falsifier: `"${klass}" recurs at the same rate with the case live.`,
      rollback: `Delete the case; retrieval returns to its prior set.`,
      autoDisable: `Disable if the class recurs unchanged after ${bounds.correctionThreshold} further occurrences.`,
      semantic: group.some((row) => row.semantic !== false), now,
    }));
  }

  for (const item of cases) {
    if (!item?.id || item.status === 'refuted') continue;
    const observed = String(item.observedOutcome ?? '');
    const expected = String(item.expectedOutcome ?? '');

    // refute — the belief's OWN falsifier was observed. Its own stated terms killed it.
    if (present(item.falsifier) && present(item.falsifierObserved)) {
      out.push(makeProposal({
        verb: 'refute', subject: item.id, klass: item.klass ?? item.id, evidenceIds: [item.falsifierObserved],
        landing: `Mark case ${item.id} refuted and retain it as negative precedent.`,
        proof: `Its stated falsifier was observed: ${String(item.falsifier).slice(0, 160)}`,
        cost: `Decisions that leaned on ${item.id} must be re-examined.`,
        falsifier: `The observation is withdrawn or shown to be out of the case's scope.`,
        rollback: `Restore status to "${item.status ?? 'active'}"; the case body is never deleted.`,
        autoDisable: `Disable refutation proposals if a human reverses two in a row.`,
        semantic: true, now,
      }));
      continue;
    }

    // amend — evidence exists and diverges from what the belief expected.
    if (present(observed) && present(expected) && observed !== expected) {
      out.push(makeProposal({
        verb: 'amend', subject: item.id, klass: item.klass ?? item.id, evidenceIds: [item.id],
        landing: `Narrow case ${item.id} to the scope its observed outcome actually supports.`,
        proof: `Observed and expected outcomes diverge on the recorded evidence.`,
        cost: `A narrower case retrieves less often.`,
        falsifier: `The wider claim holds on a case outside the narrowed scope.`,
        rollback: `Restore the previous claim text and scope.`,
        autoDisable: `Disable if amendments are reversed more than they are kept.`,
        semantic: true, now,
      }));
      continue;
    }

    // retire — ABSENCE OF USE, stated as the evidence rather than dressed up as a finding. This is
    // the verb the private loop never once reached in 55 accepted proposals.
    const reviewDate = item.reviewDate;
    if (present(reviewDate) && days(reviewDate, now) >= bounds.staleReviewDays) {
      const used = precedentUses.some((use) => use.caseId === item.id && days(use.at ?? reviewDate, now) < bounds.staleReviewDays);
      if (!used) {
        out.push(makeProposal({
          verb: 'retire', subject: item.id, klass: item.klass ?? item.id, evidenceIds: [],
          landing: `Retire case ${item.id} from active retrieval; it remains stored and searchable.`,
          proof: `No precedent use in ${bounds.staleReviewDays} days past its review date — the evidence is the absence.`,
          cost: `If it was quietly load-bearing, a future decision loses it.`,
          falsifier: `A decision within the next window needed it and did not find it.`,
          rollback: `Return status to active; nothing was deleted.`,
          autoDisable: `Disable retirement proposals if a human reinstates two retired cases.`,
          semantic: true, now,
        }));
      }
    }
  }

  return out.slice(0, bounds.maxProposalsPerRun);
}

// ── coalescing ───────────────────────────────────────────────────────────────────────────────

export const coalesceKey = (proposal) => `${proposal.verb}::${proposal.subject}`;

/**
 * Fold duplicates within a batch and against what is already open. Evidence is unioned so a
 * repeated finding strengthens the existing proposal instead of opening a second one.
 */
export function coalesce(proposals = [], existing = []) {
  const open = new Map();
  for (const item of existing) {
    if (item?.stage === 'disabled') continue;
    if (item?.verb) open.set(coalesceKey(item), item);
  }
  const fresh = new Map();
  const strengthened = [];
  for (const proposal of proposals) {
    const key = coalesceKey(proposal);
    const prior = open.get(key);
    if (prior) {
      const union = [...new Set([...(prior.evidenceIds ?? []), ...(proposal.evidenceIds ?? [])])];
      if (union.length !== (prior.evidenceIds ?? []).length) strengthened.push({ ...prior, evidenceIds: union });
      continue;
    }
    const already = fresh.get(key);
    if (already) {
      already.evidenceIds = [...new Set([...already.evidenceIds, ...proposal.evidenceIds])];
      continue;
    }
    fresh.set(key, { ...proposal, evidenceIds: [...proposal.evidenceIds] });
  }
  return { fresh: [...fresh.values()], strengthened };
}

// ── application gate ─────────────────────────────────────────────────────────────────────────

/**
 * A proposal is a proposal. This is the gate, not a comment saying there is one: a semantic change
 * CANNOT self-apply, and nothing applies without the full LANDING/PROOF/COST envelope plus an
 * independent verifier.
 */
export function canApply(proposal = {}) {
  const missing = [];
  for (const [label, value] of [['landing', proposal.landing], ['proof', proposal.proof],
    ['cost', proposal.cost], ['falsifier', proposal.falsifier], ['rollback', proposal.rollback],
    ['quality auto-disable', proposal.autoDisable]]) {
    if (!present(value)) missing.push(label);
  }
  if (!present(proposal.verifier)) missing.push('independent verifier');
  else if (String(proposal.verifier).trim() === String(proposal.maker ?? '').trim()) missing.push('verifier distinct from maker');
  if (proposal.needsHumanApproval === true && proposal.approvedByHuman !== true) missing.push('human approval for a semantic change');
  if (!(proposal.evidenceIds ?? []).length && proposal.verb !== 'retire') missing.push('evidence');
  return { ok: missing.length === 0, missing };
}

// ── emission ─────────────────────────────────────────────────────────────────────────────────

/**
 * Write proposals into `state.improvements` — the collection the Butler already reads — and record
 * the run in a bounded journal. Emitting anywhere else would produce a loop with no caller.
 */
export function emit(state, { trigger, proposals = [], strengthened = [], now, bounds = DREAM_DEFAULTS }) {
  const dream = { ...emptyDream(), ...(state.dream ?? {}) };
  const byId = new Map(strengthened.map((item) => [item.id, item]));
  const improvements = (state.improvements ?? []).map((item) => byId.get(item.id) ?? item);
  const run = {
    id: `dream-run-${now}`, trigger, at: now, producedBy: PRODUCED_BY,
    emitted: proposals.map((item) => item.id), strengthened: strengthened.map((item) => item.id),
  };
  return {
    ...state,
    improvements: [...improvements, ...proposals],
    dream: {
      ...dream,
      runs: [...dream.runs, run].slice(-bounds.maxJournalRuns),
      cursor: { turns: 0, lastRunAt: now, runsThisSession: (dream.cursor?.runsThisSession ?? 0) + 1 },
    },
  };
}

/** Proof that an emitted proposal reaches a surface a human opens — scar 2, asserted end to end. */
export function reachesHumanSurface(state, proposalId, now) {
  return computeButlerBrief(state, now).some((finding) => finding.entityId === proposalId);
}

// ── auto-disable ─────────────────────────────────────────────────────────────────────────────

/**
 * The loop's own quality signal. If humans keep disabling what it proposes, it is generating work
 * rather than absorbing it, and it turns itself off. This must be able to FIRE, not merely exist.
 */
export function qualityVerdict(state = {}, bounds = DREAM_DEFAULTS) {
  const dream = { ...emptyDream(), ...(state.dream ?? {}) };
  if (dream.disabled) return { disable: true, reason: dream.disabledReason, already: true };
  if (dream.runs.length < bounds.minRunsBeforeQualityCheck) {
    return { disable: false, reason: `only ${dream.runs.length} run(s); quality check needs ${bounds.minRunsBeforeQualityCheck}` };
  }
  const mine = (state.improvements ?? []).filter((item) => item.producedBy === PRODUCED_BY);
  if (!mine.length) return { disable: false, reason: 'no proposals to judge' };
  const rejected = mine.filter((item) => item.stage === 'disabled').length;
  const rate = rejected / mine.length;
  return rate >= bounds.rejectionRateLimit
    ? { disable: true, reason: `humans disabled ${rejected}/${mine.length} proposals (${Math.round(rate * 100)}% ≥ ${Math.round(bounds.rejectionRateLimit * 100)}%)` }
    : { disable: false, reason: `rejection rate ${Math.round(rate * 100)}% under ${Math.round(bounds.rejectionRateLimit * 100)}%` };
}

export function applyQualityVerdict(state, verdict) {
  if (!verdict.disable || verdict.already) return state;
  const dream = { ...emptyDream(), ...(state.dream ?? {}) };
  return { ...state, dream: { ...dream, disabled: true, disabledReason: verdict.reason } };
}
