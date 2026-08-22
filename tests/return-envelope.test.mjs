import assert from 'node:assert/strict';
import test from 'node:test';
import {
  alreadyDelivered, exactSession, planDelivery, REQUIRED_ENVELOPE_FIELDS, routable,
  settleOutcome, validateEnvelope, verifierIndependent,
} from '../src/return-envelope.mjs';

const complete = () => ({
  request_id: 'req-1', producing_agent: 'producer', reply_to_session_id: 'sess-1',
  reply_runtime: 'pi', reply_to_agent: 'awaiter', reply_policy: 'awaited-done',
  awaited_by: 'director', verified_by: 'verifier', missing_report_action: 're-steer-once',
});

// Pinned, not imported. A loop over REQUIRED_ENVELOPE_FIELDS that tests REQUIRED_ENVELOPE_FIELDS
// cannot fail when a field is dropped from the list — it just stops testing it. The set is spelled
// out so shrinking the contract breaks this test instead of quietly narrowing it.
const EXPECTED_FIELDS = ['request_id', 'producing_agent', 'reply_to_session_id', 'reply_runtime',
  'reply_to_agent', 'reply_policy', 'awaited_by', 'verified_by', 'missing_report_action'];

test('the required-field set is exactly the nine the contract promises', () => {
  assert.deepEqual([...REQUIRED_ENVELOPE_FIELDS].sort(), [...EXPECTED_FIELDS].sort());
});

test('an envelope missing any required field is named field by field', () => {
  assert.equal(validateEnvelope(complete()).ok, true);
  for (const field of EXPECTED_FIELDS) {
    const partial = complete();
    delete partial[field];
    const result = validateEnvelope(partial);
    assert.equal(result.ok, false, `${field} must be required`);
    assert.deepEqual(result.missing, [field]);
  }
  // Whitespace is not presence.
  assert.equal(validateEnvelope({ ...complete(), awaited_by: '   ' }).ok, false);
});

test('a self-verified return is rejected: the verifier may not be the producer', () => {
  const selfVerified = { ...complete(), verified_by: 'producer' };
  const result = validateEnvelope(selfVerified);
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, [], 'every field is present — the defect is independence');
  assert.match(result.problems.join(' '), /verifier is the producer/);
  assert.equal(verifierIndependent(selfVerified), false);
  assert.equal(verifierIndependent(complete()), true);
});

test('a return is bound to one exact session, never to an agent name', () => {
  assert.equal(exactSession({ reply_to_session_id: 'sess-1' }, 'sess-1'), true);
  assert.equal(exactSession({ reply_to_session_id: 'sess-1' }, 'sess-2'), false);
  assert.equal(exactSession({ reply_to_session_id: 'sess-1' }, ''), false);
  assert.equal(exactSession({}, 'sess-1'), false);
});

test('a request already durable in this session is acknowledged, never injected twice', () => {
  const entries = [
    { type: 'custom_message', customType: 'wos-return', details: { request_id: 'req-1' } },
    { message: { role: 'custom', customType: 'wos-return', details: { request_id: 'req-2' } } },
  ];
  assert.equal(alreadyDelivered(entries, 'req-1'), true, 'top-level entry shape');
  assert.equal(alreadyDelivered(entries, 'req-2'), true, 'nested message shape');
  assert.equal(alreadyDelivered(entries, 'req-3'), false);
  assert.equal(alreadyDelivered(entries, ''), false);
});

test('delivery planning drops foreign sessions, dedupes the batch, and re-acks survivors', () => {
  const entries = [{ type: 'custom_message', customType: 'wos-return', details: { request_id: 'req-1' } }];
  const rows = [
    { request_id: 'req-1', reply_to_session_id: 'sess-1' },   // crash-after-send: ack only
    { request_id: 'req-2', reply_to_session_id: 'sess-1' },   // fresh: inject
    { request_id: 'req-2', reply_to_session_id: 'sess-1' },   // duplicate in one batch: ack only
    { request_id: 'req-3', reply_to_session_id: 'sess-OTHER' }, // another session: not ours
    { reply_to_session_id: 'sess-1' },                         // no request id: unroutable
  ];
  const plan = planDelivery(rows, 'sess-1', entries);
  assert.deepEqual(plan.inject.map((row) => row.request_id), ['req-2']);
  assert.deepEqual(plan.acknowledgeOnly.map((row) => row.request_id), ['req-1', 'req-2']);
});

test('settling with no correlated report is returned-without-report, never done', () => {
  const envelope = complete();
  const idle = settleOutcome({ requestId: 'req-1', reports: [], idle: true, envelope });
  assert.equal(idle.done, false);
  assert.equal(idle.outcome, 'returned-without-report');
  assert.equal(idle.recovery, 're-steer-once', 'the declared recovery is owed');

  // Still running is not the same absence.
  const running = settleOutcome({ requestId: 'req-1', reports: [], idle: false, envelope });
  assert.equal(running.outcome, 'pending');
  assert.equal(running.recovery, null);

  // Somebody else's report does not close this request.
  const foreign = settleOutcome({ requestId: 'req-1', reports: [{ request_id: 'req-9' }], idle: true, envelope });
  assert.equal(foreign.outcome, 'returned-without-report');
});

test('a correlated report still fails when its envelope is incomplete or self-verified', () => {
  const envelope = complete();
  const good = settleOutcome({ requestId: 'req-1', reports: [complete()], idle: true, envelope });
  assert.equal(good.done, true);
  assert.equal(good.outcome, 'done');

  const selfVerified = settleOutcome({ requestId: 'req-1', idle: true,
    envelope: { ...envelope, verified_by: 'producer' },
    reports: [{ ...complete(), verified_by: 'producer' }] });
  assert.equal(selfVerified.done, false);
  assert.equal(selfVerified.outcome, 'blocked');
  assert.match(selfVerified.reason, /verifier is the producer/);
});

test('a report with no recipient reaches nobody while looking written', () => {
  assert.equal(routable({}).ok, false);
  assert.equal(routable({ to: '' }).ok, false);
  assert.equal(routable({ to: '  ,  ' }).ok, false);
  assert.deepEqual(routable({ to: 'a, b' }).recipients, ['a', 'b']);
  assert.deepEqual(routable({ to: ['a', 'b'] }).recipients, ['a', 'b']);
});
