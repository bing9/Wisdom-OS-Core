// Ported from the production `wos-return.ts` extension and its Python return channel.
// Preserved: the return-transaction CONTRACT — request id, producer, exact initiating session,
// named awaiter, independent verifier, missing-report recovery, report-before-idle, exactly-once
// delivery, and the rule that idle is not completion.
// Not ported: the transport. The private side dispatches through an organization-specific process
// and a private receipt ledger; only the contract above is portable.
//
// The failure this exists to prevent: a delegated agent finishes, goes idle, and the awaiting
// director reads silence as success. Absence has two causes and they are not interchangeable.

/** Every field a delegated dispatch must carry for its report to be routable and checkable. */
export const REQUIRED_ENVELOPE_FIELDS = [
  'request_id',
  'producing_agent',
  'reply_to_session_id',
  'reply_runtime',
  'reply_to_agent',
  'reply_policy',
  'awaited_by',
  'verified_by',
  'missing_report_action',
];

const filled = (value) => typeof value === 'string' ? value.trim().length > 0 : value !== undefined && value !== null;

/**
 * An envelope is complete only when every field is present AND the verifier is not the producer.
 * A self-verified return is an unverified return wearing a verifier's name.
 */
export function validateEnvelope(envelope = {}) {
  const missing = REQUIRED_ENVELOPE_FIELDS.filter((field) => !filled(envelope[field]));
  const producer = String(envelope.producing_agent ?? '').trim();
  const verifier = String(envelope.verified_by ?? '').trim();
  const problems = [...missing.map((field) => `missing ${field}`)];
  if (producer && verifier && producer === verifier) problems.push('verifier is the producer');
  return { ok: problems.length === 0, missing, problems };
}

export function verifierIndependent(envelope = {}) {
  const producer = String(envelope.producing_agent ?? '').trim();
  const verifier = String(envelope.verified_by ?? '').trim();
  return filled(producer) && filled(verifier) && producer !== verifier;
}

/**
 * A return is for exactly one session. Routing on agent name alone delivers a report into whichever
 * session answers first, which is how a report reaches the wrong reader and looks delivered.
 */
export function exactSession(row = {}, sessionId) {
  return filled(sessionId) && String(row.reply_to_session_id ?? '') === String(sessionId);
}

/**
 * Exactly-once: a request already present in this session's durable entries is acknowledged, never
 * re-injected. A crash between send and acknowledgement must not duplicate the callback, so the
 * check reads the persisted entries rather than in-memory bookkeeping.
 */
export function alreadyDelivered(entries, requestId, customType = 'wos-return') {
  if (!filled(requestId)) return false;
  return (entries ?? []).some((entry) => {
    const direct = entry?.customType === customType && entry?.details?.request_id === requestId;
    const nested = entry?.message?.customType === customType && entry?.message?.details?.request_id === requestId;
    return direct || nested;
  });
}

/** Split ready rows into what to inject and what to merely acknowledge. Pure; the caller does IO. */
export function planDelivery(rows, sessionId, entries, customType = 'wos-return') {
  const inject = [];
  const acknowledgeOnly = [];
  const seen = new Set();
  for (const row of rows ?? []) {
    if (!filled(row?.request_id) || !exactSession(row, sessionId)) continue;
    if (seen.has(row.request_id)) { acknowledgeOnly.push(row); continue; }
    seen.add(row.request_id);
    if (alreadyDelivered(entries, row.request_id, customType)) acknowledgeOnly.push(row);
    else inject.push(row);
  }
  return { inject, acknowledgeOnly };
}

export const RETURN_OUTCOMES = ['done', 'blocked', 'returned-without-report'];

/**
 * The load-bearing rule. A producer that settles without a correlated report has NOT finished; it
 * has returned without reporting, and the recovery named in the envelope is owed.
 *
 * `reports` are the rows actually observed for this request id. Idle is an input here, never a
 * verdict.
 */
export function settleOutcome({ requestId, reports = [], idle = false, envelope = {} }) {
  const correlated = reports.filter((report) => String(report?.request_id ?? '') === String(requestId));
  if (correlated.length === 0) {
    return {
      outcome: idle ? 'returned-without-report' : 'pending',
      done: false,
      recovery: idle ? (envelope.missing_report_action ?? 'none-declared') : null,
      reason: idle
        ? 'settled with no correlated producer report; idle is not completion'
        : 'still running',
    };
  }
  const envelopeCheck = validateEnvelope({ ...envelope, ...correlated.at(-1) });
  if (!envelopeCheck.ok) {
    return { outcome: 'blocked', done: false, recovery: envelope.missing_report_action ?? 'none-declared',
      reason: `report present but envelope incomplete: ${envelopeCheck.problems.join('; ')}` };
  }
  return { outcome: 'done', done: true, recovery: null, reason: 'correlated report with a complete envelope' };
}

/** A report row with no routing target reaches nobody while looking written. */
export function routable(report = {}) {
  const to = report.to;
  const list = Array.isArray(to) ? to : String(to ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
  return { ok: list.length > 0, recipients: list };
}
