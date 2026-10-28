import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { addExpense, addSettlement, proposeTransfers } from '../src/accounting.ts';
import { explainTransfer, balanceKey, balanceHistory } from '../src/balanceExplanation.ts';
import { loadBalanceSource } from '../src/balanceExplanationStorage.ts';
import { accountOwner, ApiError } from '../src/api.ts';
import { migrate, saveGroup, readGroup, readVisibleGroup } from '../src/storage.ts';
import { previewPending } from '../src/ledger.ts';
import { sqliteAdapter } from './sqlite.ts';
import type { Command, Expense, Group, Session } from '../src/types.ts';

const session: Session = { baseUrl: 'https://example.test', token: 'test', userId: '1', email: 'test@example.test' };
const bill = (id: string, paid: Record<string, string>, shares: Record<string, string>, deleted = false): Expense => ({ id, description: id, total: Object.values(paid).reduce((sum, amount) => sum + BigInt(amount), 0n).toString(), paid, shares, split: { mode: 'exact', values: shares }, deleted, version: 1, date: '2026-10-19', category: 'general', notes: '' });
function ledger(expenses: Expense[], settlements: Group['settlements'] = [], opening?: Group['opening_balance']): Group {
  const participants = ['A', 'B', 'C', 'D'].map(id => ({ id, name: id }));
  let balances = Object.fromEntries(participants.map(person => [person.id, opening?.accepted ? opening.balances[person.id] ?? '0' : '0']));
  for (const row of expenses) if (!row.deleted) balances = addExpense(balances, row.paid, row.shares);
  for (const row of settlements) if (!row.reversed) balances = addSettlement(balances, row.sender, row.recipient, row.amount);
  return { id: 'group', name: 'Trip', version: 7, participants, expenses, settlements, opening_balance: opening, balances, transfers: proposeTransfers(balances), activity: [] };
}

function friendLedger() {
  const group = ledger([
    { ...bill('early', { A: '1000' }, { A: '667', B: '333' }), description: 'test', date: '2026-10-19' },
    { ...bill('later', { A: '5400' }, { A: '2700', B: '2700' }), description: 'test', date: '2026-10-26' },
    { ...bill('food', { B: '2500' }, { A: '1250', B: '1250' }), description: 'Food', date: '2026-10-28' },
  ], [
    { id: 'reversed', sender: 'B', recipient: 'A', amount: '3533', date: '2026-10-19', reversed: true },
    { id: 'paid', sender: 'B', recipient: 'A', amount: '3033', date: '2026-10-27' },
  ]);
  return { ...group, is_direct: true, participants: group.participants.slice(0, 2), balances: { A: group.balances.A, B: group.balances.B } };
}

test('friend quick answer identifies Food after an exactly settled earlier balance', () => {
  const group = friendLedger(), history = explainTransfer(group, group, 'A', group.transfers[0]).history;
  assert.equal(history.single?.description, 'Food');
  assert.equal(history.settledDate, '2026-10-27');
  assert.deepEqual(history.entries.map(row => row.balance), ['333', '3033', '0', '-1250']);
  assert.deepEqual(history.recent.map(row => row.key), ['bill:food']);
  assert.equal(history.excluded[0].effect, '0');
  const opposite = balanceHistory(group, 'B');
  assert.deepEqual(opposite.entries.map(row => row.balance), ['-333', '-3033', '0', '1250']);
  assert.equal(opposite.single?.id, 'food');
});

test('same-day records expose only the closing balance and never invent an intra-day settlement', () => {
  const group = friendLedger();
  group.expenses[2].date = '2026-10-27';
  const history = balanceHistory(group, 'A');
  assert.equal(history.settledDate, null);
  assert.equal(history.single, null);
  assert.deepEqual(history.entries.filter(row => row.date === '2026-10-27').map(row => row.balance), [null, '-1250']);
});

test('undated payments suppress chronology and settled claims while preserving exact effects', () => {
  const group = friendLedger(); group.settlements[1].date = null;
  const history = balanceHistory(group, 'A');
  assert.equal(history.ordered, false); assert.equal(history.settledDate, null); assert.equal(history.single, null);
  assert.ok(history.entries.every(row => row.balance === null));
  assert.equal(history.entries.reduce((sum, row) => sum + BigInt(row.effect), 0n), -1250n);
  group.settlements[1].date = '2026-99-99';
  assert.equal(balanceHistory(group, 'A').ordered, false);
});

test('openings, partial repayments, deleted bills and group netting do not become a single-bill claim', () => {
  const group = friendLedger(); group.settlements[1].amount = '3000';
  group.balances = { A: '-1217', B: '1217' };
  assert.equal(balanceHistory(group, 'A').single, null);
  const opening = ledger([], [], { id: 'opening', accepted: true, balances: { A: '-250', B: '250', C: '0', D: '0' }, source: 'Agreed', cutoff: '2026-10-01', acknowledgments: {} });
  assert.equal(balanceHistory(opening, 'A').opening, '-250');
  const chain = ledger([bill('B paid for A', { B: '20000' }, { A: '20000' }), bill('C paid for B', { C: '20000' }, { B: '20000' })]);
  assert.equal(explainTransfer(chain, chain, 'A', chain.transfers[0]).history.single, null);
  const deleted = ledger([bill('Dinner', { B: '501' }, { A: '501' }), bill('Deleted', { B: '999' }, { A: '999' }, true)]);
  assert.equal(balanceHistory(deleted, 'A').excluded[0].effect, '0');
});

test('third-person netting explains the same complete Simplify plan without inventing a pairwise bill', () => {
  const group = ledger([bill('B paid for A', { B: '20000' }, { A: '20000' }), bill('C paid for B', { C: '20000' }, { B: '20000' })]);
  const before = JSON.stringify(group), result = explainTransfer(group, group, 'A', group.transfers[0]);
  assert.deepEqual(result.plan, [{ sender: 'A', recipient: 'C', amount: '20000' }]);
  assert.equal(result.people.find(person => person.id === 'B')?.balance, '0');
  assert.equal(result.people.find(person => person.id === 'A')?.share, '20000');
  assert.equal(result.owing, '20000'); assert.equal(result.owed, '20000');
  assert.equal(JSON.stringify(group), before);
});

test('multiple payers, exact paise, accepted openings, recorded payments and reversals reconcile', () => {
  const group = ledger([bill('Dinner', { A: '1001', B: '2002' }, { A: '1000', B: '1001', C: '1002' }), bill('Reversed', { C: '99999' }, { A: '99999' }, true)], [
    { id: 'active', sender: 'C', recipient: 'B', amount: '201' },
    { id: 'reversed', sender: 'C', recipient: 'A', amount: '555', reversed: true },
  ], { id: 'opening', balances: { A: '-100', B: '0', C: '100', D: '0' }, accepted: true, source: 'Agreed', cutoff: '2026-10-01', acknowledgments: {} });
  const result = explainTransfer(group, group, 'B', group.transfers.find(row => row.recipient === 'B')!);
  assert.equal(result.spending, '3003');
  assert.deepEqual(result.people.find(person => person.id === 'C'), { id: 'C', name: 'C', paid: '0', share: '1002', sent: '201', received: '0', opening: '100', balance: '-701' });
  assert.equal(result.people.find(person => person.id === 'B')?.balance, '800');
  const unaccepted = ledger([], [], { ...group.opening_balance!, accepted: false });
  assert.deepEqual(unaccepted.transfers, []);
});

test('a later suggested step uses the remaining planned balances, including large aggregate amounts', () => {
  const group = ledger([bill('A', { A: '1000000000' }, { C: '1000000000' }), bill('A again', { A: '1000000000' }, { C: '1000000000' }), bill('B', { B: '500' }, { D: '500' })]);
  const result = explainTransfer(group, group, 'D', group.transfers[1]);
  assert.equal(result.index, 1); assert.equal(result.owing, '500'); assert.equal(result.owed, '500');
  assert.equal(result.plan[0].amount, '2000000000');
  const chained = ledger([bill('A', { A: '1000', B: '500' }, { C: '1200', D: '300' })]);
  const step = explainTransfer(chained, chained, 'B', chained.transfers[1]);
  assert.equal(step.owing, '300'); assert.equal(step.owed, '500');
});

test('summary subsets, stale versions, stale transfers, unrelated users and incomplete totals fail closed', () => {
  const group = ledger([bill('Dinner', { B: '501' }, { A: '501' })]), row = group.transfers[0];
  assert.throws(() => explainTransfer({ ...group, read_mode: 'summary' }, group, 'A', row), /full breakdown/);
  assert.throws(() => explainTransfer({ ...group, version: 8 }, group, 'A', row), /changed/);
  assert.throws(() => explainTransfer(group, { ...group, balances: { ...group.balances, A: '-500' } }, 'A', row), /changed/);
  assert.throws(() => explainTransfer(group, group, 'A', { ...row, amount: '500' }), /changed/);
  assert.throws(() => explainTransfer(group, group, 'D', row), /unavailable/);
  assert.throws(() => explainTransfer({ ...group, totals: { spending: '1001', paid: { B: '501' }, shares: { A: '501' } } }, group, 'A', row), /changed/);
});

test('saved pending edits use the existing preview once and leave accepted totals untouched', () => {
  const source = ledger([bill('Dinner', { B: '501' }, { A: '501' })]);
  const edited = bill('Dinner', { B: '1001' }, { A: '500', B: '501' });
  const command: Command = { command_id: 'edit', group_id: source.id, method: 'PUT', path: '/groups/group/expenses/Dinner', body: edited, state: 'pending', error: null };
  const displayed = previewPending(source, [command]), before = JSON.stringify(source), key = balanceKey(displayed, [command]);
  const result = explainTransfer(source, displayed, 'A', displayed.transfers[0], [command]);
  assert.equal(result.pending, true); assert.equal(result.people[0].share, '500');
  assert.equal(JSON.stringify(source), before); assert.notEqual(balanceKey(displayed, []), key);
});

test('full GET caches exact version for offline use without changing the visible summary or replaying writes', async () => {
  const raw = new DatabaseSync(':memory:'), db = sqliteAdapter(raw), owner = accountOwner(session);
  try {
    await migrate(db);
    const full = ledger([bill('Dinner', { B: '501' }, { A: '501' })]);
    const summary = { ...full, read_mode: 'summary' as const, expenses: [] };
    await saveGroup(db, owner, summary, 'shared');
    const calls: unknown[] = [];
    const fresh = await loadBalanceSource(db, session, summary, () => true, async (...args) => { calls.push(args); return full; });
    assert.equal(fresh.saved, false); assert.deepEqual(calls[0], [session, full.id, 'full']);
    assert.equal((await readGroup(db, owner, full.id))?.group.expenses.length, 1);
    assert.equal((await readVisibleGroup(db, owner, full.id))?.group.read_mode, 'summary');
    assert.equal((await readVisibleGroup(db, owner, full.id))?.group.expenses.length, 0);
    assert.equal((await loadBalanceSource(db, session, summary, () => true, async () => { throw new Error('Offline'); })).saved, true);
    await assert.rejects(loadBalanceSource(db, { ...session, userId: '2' }, summary, () => true, async () => { throw new Error('Offline'); }), /Connect/);
    await assert.rejects(loadBalanceSource(db, session, { ...summary, version: 8 }, () => true, async () => { throw new Error('Offline'); }), /Connect/);
    for (const status of [401, 403, 404, 409]) await assert.rejects(loadBalanceSource(db, session, summary, () => true, async () => { throw new ApiError(status, 'Denied'); }), ApiError);
    await assert.rejects(loadBalanceSource(db, session, summary, () => true, async () => ({ ...full, version: 8 })), /changed/);
    let active = true;
    await assert.rejects(loadBalanceSource(db, session, summary, () => active, async () => { active = false; return full; }), /account changed/);
  } finally { raw.close(); }
});


test('an account change while the cache read is delayed stops before any full-group request', async () => {
  const raw = new DatabaseSync(':memory:'), db = sqliteAdapter(raw);
  try {
    await migrate(db);
    const full = ledger([bill('Dinner', { B: '501' }, { A: '501' })]);
    await saveGroup(db, accountOwner(session), full, 'shared');
    let resume!: () => void, entered!: () => void, active = true, fetches = 0;
    const gate = new Promise<void>(done => { resume = done; }), started = new Promise<void>(done => { entered = done; });
    const delayed = { ...db, async getFirstAsync<T>(sql: string, ...params: (string | number | null)[]) { entered(); await gate; return db.getFirstAsync<T>(sql, ...params); } };
    const result = loadBalanceSource(delayed, session, full, () => active, async () => { fetches++; return full; });
    await started; active = false; resume();
    await assert.rejects(result, /account changed/); assert.equal(fetches, 0);
  } finally { raw.close(); }
});
