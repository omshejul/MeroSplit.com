import * as Crypto from 'expo-crypto';
import * as SQLite from 'expo-sqlite';
import fixtures from '../../../fixtures/accounting.json';
import { accountOwner, ApiError, authenticate, expensePayload, request, syncOutbox } from './api';
import { addExpense, addSettlement, proposeTransfers, validateExpense } from './accounting';
import type { Amounts, Split } from './accounting';
import { emptyGroup } from './ledger';
import { discardCommand, enqueue, migrate, pendingCommands, publishLocal, wipeAccount } from './storage';
import type { Command, Expense, Group, Session } from './types';

function same(actual: unknown, expected: unknown, label: string) {
  const normalized = (value: unknown): string => value && typeof value === 'object' && !Array.isArray(value)
    ? JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))) : JSON.stringify(value);
  if (normalized(actual) !== normalized(expected)) throw new Error(`Self-test failed: ${label}`);
}

export function nativeAccountingTest(): string {
  for (const test of fixtures.valid_expenses) same(validateExpense(test.total, test.paid as unknown as Amounts, test.split as Split, test.participant_ids).shares, test.expected_shares, test.id);
  for (const test of fixtures.transfers) same(proposeTransfers(test.balances as Amounts), test.expected_transfers, test.id);
  let balances: Amounts = Object.fromEntries(fixtures.native_replay.participants.map(id => [id, '0']));
  for (const event of fixtures.native_replay.events) {
    balances = event.type === 'expense' ? addExpense(balances, event.paid!, event.share!) : addSettlement(balances, event.sender!, event.recipient!, event.amount!);
    same(balances, event.expected_net_after, event.id);
  }
  return 'Native BigInt fixtures and cumulative ledger passed.';
}

export async function nativeServerTest(session: Session): Promise<string> {
  nativeAccountingTest();
  const owner = accountOwner(session), groupId = Crypto.randomUUID(), ids = [Crypto.randomUUID(), Crypto.randomUUID(), Crypto.randomUUID()].sort();
  const names = fixtures.native_replay.participants, mapping = Object.fromEntries(names.map((name, index) => [name, ids[index]]));
  const remap = (vector: Record<string, string>) => Object.fromEntries(Object.entries(vector).map(([key, amount]) => [mapping[key], amount]));
  const group = emptyGroup(groupId, `Native self-test ${groupId.slice(0, 8)}`, names.map(name => ({ id: mapping[name], name })));
  let db = await SQLite.openDatabaseAsync('splitdumb-server-selftest.db');
  const make = (path: string, body: Record<string, unknown>): Command => { const commandId = Crypto.randomUUID(); return { command_id: commandId, group_id: groupId, method: 'POST', path, body: { ...body, command_id: commandId }, state: 'pending', error: null }; };
  try {
    await migrate(db); await wipeAccount(db, owner);
    await publishLocal(db, owner, group, [make('/groups', { id: groupId, name: group.name, participants: group.participants, self_participant_id: mapping.A })]);
    await db.closeAsync(); db = await SQLite.openDatabaseAsync('splitdumb-server-selftest.db');
    same((await pendingCommands(db, owner)).length, 1, 'outbox survives native close and reopen');
    await syncOutbox(db, session);
    let firstExpense: Expense | undefined;
    for (const event of fixtures.native_replay.events) {
      let command: Command;
      if (event.type === 'expense') {
        const expense: Expense = { id: Crypto.randomUUID(), version: 0, description: `Synthetic ${event.id}`, total: event.total!, paid: remap(event.paid!), shares: remap(event.share!), split: { mode: 'exact', values: remap(event.share!) }, date: '2026-10-16', category: 'test', notes: 'Synthetic functional test. No money transferred.', deleted: false };
        firstExpense ??= expense;
        command = make(`/groups/${groupId}/expenses`, expensePayload(expense));
      } else command = make(`/groups/${groupId}/settlements`, { id: Crypto.randomUUID(), sender: mapping[event.sender!], recipient: mapping[event.recipient!], amount: event.amount! });
      await enqueue(db, owner, command); await syncOutbox(db, session);
      const snapshot = await request<Group>(session, `/groups/${groupId}`);
      same(snapshot.balances, remap(event.expected_net_after), `${event.id} native/backend balance parity`);
      await request(session, command.path, command.method, command.body);
      same((await request<Group>(session, `/groups/${groupId}`)).version, snapshot.version, 'same command does not post twice');
    }
    const snapshot = await request<Group>(session, `/groups/${groupId}`), expense = snapshot.expenses.find(row => row.id === firstExpense?.id)!;
    await request(session, `/groups/${groupId}/expenses/${expense.id}`, 'PUT', { ...expensePayload(expense, true), command_id: Crypto.randomUUID(), description: 'Accepted newer revision' });
    const stale = make(`/groups/${groupId}/expenses/${expense.id}`, { ...expensePayload(expense, true), description: 'Conflicting offline revision' }); stale.method = 'PUT';
    await enqueue(db, owner, stale);
    try { await syncOutbox(db, session); throw new Error('Expected revision conflict.'); } catch (error) { if (!(error instanceof ApiError) || error.status !== 409) throw error; }
    same((await pendingCommands(db, owner))[0].state, 'conflict', 'conflict remains durable');
    await discardCommand(db, owner, stale.command_id);
    await request(session, `/groups/${groupId}/export?format=json`);
    const csv = await request<string>(session, `/groups/${groupId}/export?format=csv`, 'GET', undefined, 'text');
    if (!csv.includes('Synthetic') && !csv.includes('Accepted newer revision')) throw new Error('CSV export did not contain the test ledger.');

    // Separate disposable accounts keep the caller's own payment profile intact.
    const signup = () => authenticate(session.baseUrl, `native-payment-${Crypto.randomUUID()}@splitdumb.invalid`, `Test!${Crypto.randomUUID()}${Crypto.randomUUID()}`, true);
    const receiver = await signup(), payer = await signup(), paymentGroupId = Crypto.randomUUID();
    const receiverId = Crypto.randomUUID(), payerId = Crypto.randomUUID(), prefix = `/groups/${paymentGroupId}`;
    const post = (actor: Session, path: string, body: Record<string, unknown> = {}) => request<Record<string, unknown>>(actor, path, 'POST', { ...body, command_id: Crypto.randomUUID() });
    const paymentSnapshot = (actor = receiver) => request<Group & { invites: { id: string; participant_id: string }[] }>(actor, prefix);
    await post(receiver, '/groups', { id: paymentGroupId, name: 'Native synthetic payment records', self_participant_id: receiverId, participants: [{ id: receiverId, name: 'Receiver' }, { id: payerId, name: 'Payer' }] });
    await post(receiver, `${prefix}/expenses`, { id: Crypto.randomUUID(), description: 'Native synthetic payment bill', total: '30000', paid: { [receiverId]: '30000' }, split: { mode: 'equal', values: { [receiverId]: '1', [payerId]: '1' } }, date: '2026-10-16', category: 'test', notes: 'No bank transfer.' });
    const invitation = await post(receiver, `${prefix}/invites`, { participant_id: payerId });
    await post(payer, `/invites/${String(invitation.token)}/claim`);
    const inviteId = (await paymentSnapshot()).invites.find(invite => invite.participant_id === payerId)!.id;
    await post(receiver, `${prefix}/invites/${inviteId}/approve`);
    same((await paymentSnapshot(payer)).participants.find(person => person.id === payerId)?.user_id, Number(payer.userId), 'scoped claim requires explicit approval');
    await request(receiver, '/me/payment-profile', 'PUT', { vpa: 'synthetic@okaxis' });
    const prepare = async () => {
      const before = await paymentSnapshot(payer), profile = before.participants.find(person => person.id === receiverId)!.payment_profile!;
      await post(payer, `${prefix}/payment-attempts`, { id: Crypto.randomUUID(), sender: payerId, recipient: receiverId, amount: '10000', group_version: before.version, payee_version: profile.version });
      const active = (await paymentSnapshot(payer)).payment_attempts?.find(attempt => attempt.sender === payerId && attempt.recipient === receiverId && ['prepared', 'reported'].includes(attempt.state));
      if (!active) throw new Error('Self-test failed: active payment attempt missing.');
      return active.id;
    };
    const attemptId = await prepare();
    same(await prepare(), attemptId, 'active attempt reused with a different command ID');
    const details = await request<{ bank_verified: boolean; direct_launch_supported: boolean }>(payer, `${prefix}/payment-attempts/${attemptId}/launch`);
    same(details.bank_verified, false, 'no bank verification claim'); same(details.direct_launch_supported, false, 'no untested app launch claim');
    const beforeReport = (await paymentSnapshot()).balances;
    await post(payer, `${prefix}/payment-attempts/${attemptId}/report`);
    same((await paymentSnapshot()).balances, beforeReport, 'payer report cannot post a settlement');
    await post(payer, `${prefix}/settlements`, { id: Crypto.randomUUID(), sender: payerId, recipient: receiverId, amount: '7000', attempt_id: attemptId });
    const actualBalances = { [receiverId]: '8000', [payerId]: '-8000' };
    same((await paymentSnapshot()).balances, actualBalances, 'actual partial manual amount differs from the quote');
    await post(receiver, `${prefix}/payment-attempts/${attemptId}/confirm`);
    const confirmed = await paymentSnapshot();
    same(confirmed.balances, actualBalances, 'recipient confirmation does not post a second settlement');
    same(confirmed.payment_attempts?.find(attempt => attempt.id === attemptId)?.recorded_amount, '7000', 'actual recorded amount retained');
    await request(receiver, `${prefix}/export?format=json`);
    const paymentCsv = await request<string>(receiver, `${prefix}/export?format=csv`, 'GET', undefined, 'text');
    if (!paymentCsv.includes('Native synthetic payment bill')) throw new Error('Self-test failed: payment CSV missing bill.');
    return `Native/server self-test passed. Groups ${groupId}, ${paymentGroupId}. SQLite restart, five fixture events, duplicate retries, revision conflict, scoped claims, VPA ownership, reused attempt, report without posting, partial manual payment, confirmation without double posting, and JSON/CSV exports checked. No bank transfer.`;
  } finally { await db.closeAsync(); }
}
