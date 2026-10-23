import test from 'node:test';
import assert from 'node:assert/strict';
import { addExpense, addSettlement, proposeTransfers, validateExpense } from '../src/accounting.ts';
import { personalSettlements, personalTransfers, selfParticipant, visiblePeopleSummary } from '../src/personalBalances.ts';
import type { Group } from '../src/types.ts';

function group(balances: Record<string, string>): Group {
  return { id: 'g', name: 'Test group', version: 1,
    participants: Object.keys(balances).map((id, index) => ({ id, name: id, user_id: index + 1 })),
    balances, transfers: proposeTransfers(balances), expenses: [], settlements: [], activity: [] };
}

test('Simplify is computed for everyone before selecting incoming and outgoing own obligations', () => {
  const ledger = group({ self: '300', creditor: '700', debtor: '-600', other: '-400' });
  const original = structuredClone(ledger);
  assert.deepEqual(personalTransfers(ledger, 'self'), [{ sender: 'other', recipient: 'self', amount: '300' }]);
  assert.deepEqual(personalTransfers(ledger, 'debtor'), [{ sender: 'debtor', recipient: 'creditor', amount: '600' }]);
  assert.deepEqual(ledger, original);
  // Filtering balances first would lose this third-party obligation and break zero-sum accounting.
  assert.equal(ledger.transfers.length, 3);
});

test('personal zero hides third-party transfers and records without discarding canonical history', () => {
  const ledger = group({ self: '0', creditor: '500', debtor: '-500' });
  ledger.settlements = [{ id: 'other-payment', sender: 'debtor', recipient: 'creditor', amount: '100' }];
  assert.deepEqual(personalTransfers(ledger, 'self'), []);
  assert.deepEqual(personalSettlements(ledger, 'self'), []);
  assert.equal(ledger.transfers.length, 1);
  assert.equal(ledger.settlements.length, 1);
});

test('own payment history retains both directions and reversals, not third-party records', () => {
  const ledger = group({ self: '0', other: '0', third: '0' });
  ledger.settlements = [
    { id: 'incoming', sender: 'other', recipient: 'self', amount: '100' },
    { id: 'outgoing', sender: 'self', recipient: 'other', amount: '200', reversed: true },
    { id: 'unrelated', sender: 'other', recipient: 'third', amount: '300' },
  ];
  assert.deepEqual(personalSettlements(ledger, 'self').map(row => row.id), ['incoming', 'outgoing']);
});

test('canonical totals and awkward paise are unchanged by personal display filtering', () => {
  const ledger = group({ self: '0', other: '0', third: '0' });
  const expense = validateExpense('1001', { self: '401', other: '600' }, { mode: 'equal', values: { self: '1', other: '1', third: '1' } }, ['self', 'other', 'third']);
  ledger.balances = addSettlement(addExpense(ledger.balances, expense.paid, expense.shares), 'third', 'other', '100');
  ledger.transfers = proposeTransfers(ledger.balances);
  ledger.totals = { spending: '1001', paid: expense.paid, shares: expense.shares };
  const original = structuredClone(ledger);
  const own = personalTransfers(ledger, 'self');
  assert.equal(own.reduce((total, transfer) => total + BigInt(transfer.amount) * (transfer.recipient === 'self' ? 1n : -1n), 0n).toString(), ledger.balances.self);
  assert.deepEqual(ledger, original);
  assert.equal(Object.values(ledger.totals.shares).reduce((sum, value) => sum + BigInt(value), 0n), 1001n);
});

test('self resolution uses active account identity; removed counterpart cannot hide an own obligation', () => {
  const ledger = group({ self: '-500', other: '500' });
  ledger.is_direct = true;
  ledger.participants[0].name = 'Someone else';
  ledger.participants[1].name = 'You';
  ledger.participants[1].removed = true;
  assert.equal(selfParticipant(ledger, '1')?.id, 'self');
  assert.equal(selfParticipant(ledger, '2'), undefined);
  assert.equal(selfParticipant(ledger, 'missing'), undefined);
  assert.equal(visiblePeopleSummary(ledger, '1'), true);
  assert.equal(personalTransfers(ledger, 'self').length, 1);
  assert.deepEqual(personalTransfers(ledger, 'other'), []);
});

test('People keeps fresh contacts and pending changes, hides settled history and irrelevant removed people', () => {
  const ledger = group({ self: '0', other: '0' });
  ledger.is_direct = true;
  assert.equal(visiblePeopleSummary(ledger, '1'), true);
  ledger.totals = { spending: '200', paid: { self: '100', other: '100' }, shares: { self: '100', other: '100' } };
  assert.equal(visiblePeopleSummary(ledger, '1'), false);
  assert.equal(visiblePeopleSummary(ledger, '1', true), true);
  delete ledger.totals;
  ledger.participants[1].removed = true;
  assert.equal(visiblePeopleSummary(ledger, '1'), false);
  assert.equal(visiblePeopleSummary(ledger, '1', true), true);
  ledger.participants[0].removed = true;
  assert.equal(visiblePeopleSummary(ledger, '1', true), false);
  ledger.participants[0].removed = false;
  ledger.is_direct = false;
  assert.equal(visiblePeopleSummary(ledger, '1', true), false);
});

test('personal payment guard permits either own direction, but rejects third-party, self and removed pairs', async () => {
  const { isPersonalPayment } = await import('../src/personalBalances.ts');
  const ledger = group({ self: '-100', other: '200', third: '-100' });
  assert.equal(isPersonalPayment(ledger, 'self', 'self', 'other'), true);
  assert.equal(isPersonalPayment(ledger, 'self', 'third', 'self'), true);
  assert.equal(isPersonalPayment(ledger, 'self', 'third', 'other'), false);
  assert.equal(isPersonalPayment(ledger, 'self', 'self', 'self'), false);
  assert.equal(isPersonalPayment(ledger, 'self', 'self', ''), false);
  ledger.participants[1].removed = true;
  assert.equal(isPersonalPayment(ledger, 'self', 'self', 'other'), false);
  ledger.participants[0].removed = true;
  assert.equal(isPersonalPayment(ledger, 'self', 'third', 'self'), false);
});

test('net-zero self retains both canonical directions before any summary filtering', () => {
  const ledger = group({ self: '0', creditor: '500', debtor: '-500' });
  ledger.transfers = [
    { sender: 'debtor', recipient: 'self', amount: '500' },
    { sender: 'self', recipient: 'creditor', amount: '500' },
  ];
  const original = structuredClone(ledger);
  assert.deepEqual(personalTransfers(ledger, 'self'), ledger.transfers);
  assert.deepEqual(ledger, original);
});

test('an unlinked or deleted-account active counterpart remains eligible for personal records', async () => {
  const { isPersonalPayment } = await import('../src/personalBalances.ts');
  const ledger = group({ self: '-500', other: '500' });
  ledger.participants[1] = { id: 'other', name: 'Deleted user', user_id: null, removed: false };
  assert.equal(isPersonalPayment(ledger, 'self', 'self', 'other'), true);
  assert.equal(isPersonalPayment(ledger, 'self', 'other', 'self'), true);
  ledger.participants[1].removed = true;
  assert.equal(isPersonalPayment(ledger, 'self', 'self', 'other'), false);
});
