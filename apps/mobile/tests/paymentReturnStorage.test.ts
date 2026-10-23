import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accountOwner } from '../src/api.ts';
import { migrate, enqueue, pendingCommands, readDraft, saveDraft, readVisibleGroup } from '../src/storage.ts';
import { createPaymentReturn, PaymentReturnReviewError } from '../src/paymentReturn.ts';
import type { PaymentReturn } from '../src/paymentReturn.ts';
import { savePaymentReturn, listPaymentReturns, clearPaymentReturn, paymentReturnCommand, resolvePaymentReturn } from '../src/paymentReturnStorage.ts';
import { sqliteAdapter } from './sqlite.ts';
import type { Group, Session, Settlement } from '../src/types.ts';

const session: Session = { token: 'fake-only-token', userId: '17', email: 'payer@example.invalid', baseUrl: 'https://payment-return.invalid' };
const owner = accountOwner(session);
const identity = { groupId: 'g', groupVersion: 7, attemptId: 'attempt-original', sender: 'self', recipient: 'payee', amount: '334', payeeName: 'Frozen Payee', vpa: 'synthetic@invalid', yesCommandId: 'yes-original', noCommandId: 'no-original', settlementId: 'payment-original', date: '2026-10-17' };
const record = (decision: PaymentReturn['decision'] = 'paid'): PaymentReturn => ({ ...createPaymentReturn(identity), launch: 'opened', handoffConfirmed: true, leftApp: true, returned: true, decision });
function fixture() {
  let group: Group = { id: 'g', name: 'Payment return QA', version: 7, read_mode: 'summary', participants: [{ id: 'self', name: 'Payer', user_id: 17 }, { id: 'payee', name: 'Payee', user_id: 18 }], expenses: [], settlements: [], activity: [], transactions: [], balances: { self: '-1000', payee: '1000' }, transfers: [{ sender: 'self', recipient: 'payee', amount: '1000' }], totals: { spending: '1000', paid: { self: '0', payee: '1000' }, shares: { self: '1000', payee: '0' } }, history: { bills: { next_cursor: null }, settlements: { next_cursor: null }, attempts: { next_cursor: null }, activity: { next_cursor: null }, transactions: { next_cursor: null } } };
  let state = 'prepared', settlement: Settlement | null = null;
  const posts: { path: string; body: Record<string, unknown> }[] = [], accepted = new Map<string, string>();
  let applied = 0, reads = 0, failSummaryAfterPost = false, summaryFailurePending = false, exactStatus = 200;
  let summaryTransform = (value: Group): unknown => value;
  const original = globalThis.fetch;
  globalThis.fetch = async (input, options) => {
    const url = new URL(String(input)), path = url.pathname.replace('/api/v1', '');
    assert.equal((options?.headers as Record<string, string>)['X-Session-Token'], session.token);
    if (options?.method === 'POST') {
      const body = JSON.parse(String(options.body)); posts.push({ path, body });
      const signature = JSON.stringify(body), prior = accepted.get(body.command_id);
      if (prior && prior !== signature) return Response.json({ detail: 'Changed immutable command' }, { status: 409 });
      if (!prior) {
        if (path.endsWith('/settlements')) {
          assert.equal(body.attempt_id, identity.attemptId);
          if (body.expected_group_version !== group.version || state !== 'prepared') return Response.json({ detail: 'Payment changed' }, { status: 409 });
          settlement = { id: body.id, sender: body.sender, recipient: body.recipient, amount: body.amount, attempt_id: body.attempt_id, date: body.date, method: 'manual_record', reversed: false };
          state = 'recorded'; group = { ...group, version: group.version + 1, settlements: [settlement], balances: { self: '-666', payee: '666' }, transfers: [{ sender: 'self', recipient: 'payee', amount: '666' }] };
        } else {
          assert.equal(path, `/groups/g/payment-attempts/${identity.attemptId}/cancel`);
          if (state !== 'prepared') return Response.json({ detail: 'Not cancellable' }, { status: 409 });
          state = 'cancelled'; group = { ...group, version: group.version + 1 };
        }
        accepted.set(body.command_id, signature); applied++;
      }
      if (failSummaryAfterPost) { failSummaryAfterPost = false; summaryFailurePending = true; }
      return Response.json({ id: group.id, version: group.version });
    }
    reads++;
    if (path === '/groups/g/summary') {
      if (summaryFailurePending) { summaryFailurePending = false; throw new TypeError('GET lost after accepted POST'); }
      return Response.json(summaryTransform(structuredClone(group)));
    }
    assert.equal(path, `/groups/g/payment-attempts/${identity.attemptId}`);
    if (exactStatus !== 200) return Response.json({ detail: 'Unavailable attempt' }, { status: exactStatus });
    return Response.json({ id: identity.attemptId, sender: identity.sender, recipient: identity.recipient, amount: identity.amount, state, current_group_version: group.version, settlement });
  };
  return {
    get group() { return group; }, set group(value: Group) { group = value; },
    get state() { return state; }, set state(value: string) { state = value; },
    get settlement() { return settlement; }, set settlement(value: Settlement | null) { settlement = value; },
    get posts() { return posts; }, get applied() { return applied; }, get reads() { return reads; },
    failNextAcceptedRead() { failSummaryAfterPost = true; },
    changeSummary(transform: typeof summaryTransform) { summaryTransform = transform; },
    denyAttempt(status: number) { exactStatus = status; },
    restore() { globalThis.fetch = original; },
  };
}

function memory() { const raw = new DatabaseSync(':memory:'); return { raw, db: sqliteAdapter(raw) }; }

test('payment-return reservations survive real SQLite restart without overwriting bill drafts or another account', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'merosplit-return-')), file = join(folder, 'qa.db');
  let raw = new DatabaseSync(file), db = sqliteAdapter(raw);
  try {
    await migrate(db); await saveDraft(db, owner, 'g', { description: 'Unsent dinner', amount: '12.34' });
    await savePaymentReturn(db, owner, record());
    await savePaymentReturn(db, 'other-owner', { ...record(), yesCommandId: 'other-yes' });
    raw.close(); raw = new DatabaseSync(file); db = sqliteAdapter(raw);
    assert.deepEqual(await listPaymentReturns(db, owner), [record()]);
    assert.deepEqual(await readDraft(db, owner, 'g'), { description: 'Unsent dinner', amount: '12.34' });
    for (const change of [{ amount: '335' }, { recipient: 'another' }, { groupVersion: 8 }, { yesCommandId: 'new-yes' }, { noCommandId: 'new-no' }, { settlementId: 'new-payment' }, { date: '2026-10-18' }, { decision: 'unpaid' as const }]) await assert.rejects(savePaymentReturn(db, owner, { ...record(), ...change }), /cannot be changed/);
    await clearPaymentReturn(db, owner, identity.attemptId);
    assert.deepEqual(await listPaymentReturns(db, owner), []);
    assert.equal((await listPaymentReturns(db, 'other-owner'))[0].yesCommandId, 'other-yes');
    assert.ok(await readDraft(db, owner, 'g'));
  } finally { raw.close(); rmSync(folder, { recursive: true, force: true }); }
});

test('concurrent first reservations cannot replace frozen financial identities', async () => {
  const { raw, db } = memory();
  try {
    await migrate(db);
    const competing = { ...record(), yesCommandId: 'racing-yes', settlementId: 'racing-payment' };
    const results = await Promise.allSettled([savePaymentReturn(db, owner, record()), savePaymentReturn(db, owner, competing)]);
    assert.equal(results.filter(value => value.status === 'fulfilled').length, 1, 'only one immutable identity can win');
    const winner = results[0].status === 'fulfilled' ? record() : competing;
    assert.deepEqual(await listPaymentReturns(db, owner), [winner]);
  } finally { raw.close(); }
});

test('Yes applies one exact frozen settlement; canonical replay clears reminder without a second POST', async () => {
  const { raw, db } = memory(), server = fixture();
  try {
    await migrate(db); await savePaymentReturn(db, owner, record());
    const result = await resolvePaymentReturn(db, session, record());
    assert.equal(result.balances.self, '-666'); assert.equal(server.applied, 1);
    assert.deepEqual(server.posts[0], { path: '/groups/g/settlements', body: paymentReturnCommand(record()).body });
    assert.deepEqual(await pendingCommands(db, owner), []); assert.deepEqual(await listPaymentReturns(db, owner), []);
    // Simulate interruption after accepted canonical read but before deleting the reminder.
    await savePaymentReturn(db, owner, record());
    await resolvePaymentReturn(db, session, record());
    assert.equal(server.posts.length, 1); assert.equal(server.group.settlements.length, 1);
    assert.equal((await readVisibleGroup(db, owner, 'g'))?.group.version, 8);
  } finally { server.restore(); raw.close(); }
});

test('No cancels only its exact prepared attempt and never posts a settlement', async () => {
  const { raw, db } = memory(), server = fixture(), unpaid = record('unpaid');
  try {
    await migrate(db); await savePaymentReturn(db, owner, unpaid);
    await resolvePaymentReturn(db, session, unpaid);
    assert.deepEqual(server.posts, [{ path: `/groups/g/payment-attempts/${identity.attemptId}/cancel`, body: { command_id: identity.noCommandId } }]);
    assert.equal(server.state, 'cancelled'); assert.equal(server.group.settlements.length, 0); assert.equal(server.group.balances.self, '-1000');
    await savePaymentReturn(db, owner, unpaid); await resolvePaymentReturn(db, session, unpaid);
    assert.equal(server.posts.length, 1);
  } finally { server.restore(); raw.close(); }
});

test('accepted POST then lost GET survives restart and replays exactly the same command once', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'merosplit-return-retry-')), file = join(folder, 'qa.db');
  let raw = new DatabaseSync(file), db = sqliteAdapter(raw); const server = fixture();
  try {
    await migrate(db); await savePaymentReturn(db, owner, record()); server.failNextAcceptedRead();
    await assert.rejects(resolvePaymentReturn(db, session, record()), /Could not connect/);
    assert.equal(server.applied, 1); assert.equal((await pendingCommands(db, owner))[0].state, 'pending');
    raw.close(); raw = new DatabaseSync(file); db = sqliteAdapter(raw);
    const restored = (await listPaymentReturns(db, owner))[0];
    assert.deepEqual(restored, record()); await resolvePaymentReturn(db, session, restored);
    assert.equal(server.posts.length, 2); assert.deepEqual(server.posts[1], server.posts[0]);
    assert.equal(server.applied, 1); assert.equal(server.group.settlements.length, 1);
    assert.deepEqual(await pendingCommands(db, owner), []); assert.deepEqual(await listPaymentReturns(db, owner), []);
  } finally { server.restore(); raw.close(); rmSync(folder, { recursive: true, force: true }); }
});

test('changed group, terminal attempt, removed party and wrong payer fail closed without generating financial IDs', async () => {
  for (const variant of ['changed-version', 'reported', 'recorded-other', 'confirmed-other', 'reversed', 'removed', 'wrong-payer']) {
    const { raw, db } = memory(), server = fixture();
    try {
      await migrate(db); await savePaymentReturn(db, owner, record());
      if (variant === 'changed-version') server.group = { ...server.group, version: 8 };
      if (variant === 'reported') server.state = 'reported';
      if (variant.includes('other') || variant === 'reversed') {
        server.state = variant.startsWith('confirmed') ? 'confirmed' : 'recorded';
        server.settlement = { id: variant === 'reversed' ? identity.settlementId : 'someone-elses-payment', sender: 'self', recipient: 'payee', amount: '334', attempt_id: identity.attemptId, reversed: variant === 'reversed' };
      }
      if (variant === 'removed') server.group.participants[1].removed = true;
      if (variant === 'wrong-payer') server.group.participants[0].user_id = 99;
      await assert.rejects(resolvePaymentReturn(db, session, record()), PaymentReturnReviewError, variant);
      assert.equal(server.posts.length, 0, variant); assert.deepEqual(await pendingCommands(db, owner), []);
      assert.deepEqual(await listPaymentReturns(db, owner), [record()]);
    } finally { server.restore(); raw.close(); }
  }
});

test('another account, backend or unknown attempt cannot resolve the saved payer record', async () => {
  const { raw, db } = memory(), server = fixture();
  try {
    await migrate(db); await savePaymentReturn(db, owner, record());
    for (const other of [{ ...session, userId: '99' }, { ...session, baseUrl: 'https://another.invalid' }]) await assert.rejects(resolvePaymentReturn(db, other, record()), PaymentReturnReviewError);
    assert.equal(server.reads, 0); server.denyAttempt(404);
    await assert.rejects(resolvePaymentReturn(db, session, record()), PaymentReturnReviewError);
    assert.equal(server.posts.length, 0); assert.deepEqual(await listPaymentReturns(db, owner), [record()]);
  } finally { server.restore(); raw.close(); }
});

test('an incomplete canonical summary cannot authorize a write or clear an accepted reminder', async () => {
  for (const accepted of [false, true]) {
    const { raw, db } = memory(), server = fixture();
    try {
      await migrate(db); await savePaymentReturn(db, owner, record());
      if (accepted) {
        server.state = 'recorded'; server.settlement = { id: identity.settlementId, sender: 'self', recipient: 'payee', amount: '334', attempt_id: identity.attemptId, reversed: false };
      }
      server.changeSummary(group => { const { totals, history, balances, ...incomplete } = group; return incomplete; });
      await assert.rejects(resolvePaymentReturn(db, session, record()));
      assert.equal(server.posts.length, 0, 'incomplete financial evidence must fail before POST');
      assert.deepEqual(await listPaymentReturns(db, owner), [record()]);
      assert.equal(await readVisibleGroup(db, owner, 'g'), null);
    } finally { server.restore(); raw.close(); }
  }
});

test('a mismatched queued body is never replayed under the reserved financial identity', async () => {
  const { raw, db } = memory(), server = fixture();
  try {
    await migrate(db); await savePaymentReturn(db, owner, record());
    const command = paymentReturnCommand(record()); await enqueue(db, owner, { ...command, body: { ...command.body, amount: '335' } });
    await assert.rejects(resolvePaymentReturn(db, session, record()), PaymentReturnReviewError);
    assert.equal(server.posts.length, 0); assert.equal((await pendingCommands(db, owner))[0].body.amount, '335');
  } finally { server.restore(); raw.close(); }
});


test('incomplete local reminders stay available for recovery without reaching the payment UI', async () => {
  const { raw, db } = memory();
  try {
    await migrate(db);
    const partial = { schemaVersion: 1, groupId: 'g', groupVersion: 7, attemptId: 'incomplete' };
    await saveDraft(db, owner, 'payment-return:incomplete', partial);
    assert.deepEqual(await listPaymentReturns(db, owner), []);
    assert.deepEqual(await readDraft(db, owner, 'payment-return:incomplete'), partial);
  } finally { raw.close(); }
});

test('a queued mutation with another HTTP method is not an exact immutable retry', async () => {
  const { raw, db } = memory(), server = fixture();
  try {
    await migrate(db); await savePaymentReturn(db, owner, record());
    await enqueue(db, owner, { ...paymentReturnCommand(record()), method: 'PUT' });
    await assert.rejects(resolvePaymentReturn(db, session, record()), PaymentReturnReviewError);
    assert.equal(server.posts.length, 0); assert.equal(server.reads, 0);
    assert.equal((await pendingCommands(db, owner))[0].method, 'PUT');
  } finally { server.restore(); raw.close(); }
});

test('No on an already reported attempt preserves that report rather than cancelling or recording', async () => {
  const { raw, db } = memory(), server = fixture(), unpaid = record('unpaid');
  try {
    await migrate(db); await savePaymentReturn(db, owner, unpaid); server.state = 'reported';
    await assert.rejects(resolvePaymentReturn(db, session, unpaid), PaymentReturnReviewError);
    assert.equal(server.posts.length, 0); assert.equal(server.state, 'reported'); assert.equal(server.group.settlements.length, 0);
    assert.deepEqual(await listPaymentReturns(db, owner), [unpaid]);
  } finally { server.restore(); raw.close(); }
});
