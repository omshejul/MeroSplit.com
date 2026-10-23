import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateExpense, proposeTransfers, addExpense, addSettlement, rupeesToPaise, formatMoney, expenseBalanceChange, settlementCashflow } from '../src/accounting.ts';
import type { Split } from '../src/accounting.ts';

const fixtures = JSON.parse(readFileSync(new URL('../../../fixtures/accounting.json', import.meta.url), 'utf8'));
for (const fixture of fixtures.valid_expenses) {
  test(`Python/TypeScript expense: ${fixture.id}`, () => {
    assert.deepEqual(validateExpense(fixture.total, fixture.paid, fixture.split as Split, fixture.participant_ids), { paid: fixture.expected_paid, shares: fixture.expected_shares });
  });
}
for (const fixture of fixtures.invalid_expenses) {
  test(`Reject invalid expense: ${fixture.id}`, () => {
    assert.throws(() => validateExpense(fixture.total, fixture.paid, fixture.split as Split, fixture.participant_ids));
  });
}
for (const fixture of fixtures.transfers) {
  test(`Python/TypeScript transfer: ${fixture.id}`, () => assert.deepEqual(proposeTransfers(fixture.balances), fixture.expected_transfers));
}
for (const fixture of fixtures.invalid_transfers) {
  test(`Reject invalid transfer: ${fixture.id}`, () => assert.throws(() => proposeTransfers(fixture.balances)));
}
for (const scenario of fixtures.ledger_scenarios) {
  test(`Cumulative ledger parity: ${scenario.id}`, () => {
    let balances = Object.fromEntries(scenario.participants.map((id: string) => [id, '0']));
    for (const expense of scenario.expenses) {
      const vectors = validateExpense(expense.total, expense.paid, expense.split, scenario.participants);
      balances = addExpense(balances, vectors.paid, vectors.shares);
    }
    for (const settlement of scenario.settlements) balances = addSettlement(balances, settlement.sender, settlement.recipient, settlement.amount);
    assert.deepEqual(balances, scenario.expected_balances);
  });
}
test('Replay the native-observed cumulative fixture', () => {
  const replay = fixtures.native_replay;
  let balances = Object.fromEntries(replay.participants.map((id: string) => [id, '0']));
  for (const event of replay.events) {
    balances = event.type === 'expense' ? addExpense(balances, event.paid, event.share) : addSettlement(balances, event.sender, event.recipient, event.amount);
    assert.deepEqual(balances, event.expected_net_after);
  }
  assert.deepEqual(balances, replay.expected_final_net);
});
test('Paid minus share and repayment signs reconcile', () => {
  const expense = validateExpense('120000', { A: '120000' }, { mode: 'equal', values: { A: '1', B: '1', C: '1' } }, ['A', 'B', 'C']);
  const balances = addExpense({ A: '0', B: '0', C: '0' }, expense.paid, expense.shares);
  assert.deepEqual(balances, { A: '80000', B: '-40000', C: '-40000' });
  assert.deepEqual(addSettlement(balances, 'B', 'A', '15000'), { A: '65000', B: '-25000', C: '-40000' });
  assert.deepEqual(addExpense(balances, expense.paid, expense.shares, -1n), { A: '0', B: '0', C: '0' });
});
test('INR parsing and display do not round or lose precision', () => {
  assert.equal(rupeesToPaise('10000000.00'), '1000000000');
  assert.equal(formatMoney('-123456789'), '-₹12,34,567.89');
  for (const value of ['1.001', ' 1', '-1', '1e4', '01.00', '0', '10000000.01']) assert.throws(() => rupeesToPaise(value));
});

test('Bill direction uses each payer’s allocated share, including payers who still owe', () => {
  const expense = validateExpense('1001', { A: '400', B: '601' }, { mode: 'exact', values: { A: '700', B: '301', C: '0' } }, ['A', 'B', 'C']);
  assert.equal(expenseBalanceChange(expense, 'A'), '-300');
  assert.equal(expenseBalanceChange(expense, 'B'), '300');
  assert.equal(expenseBalanceChange(expense, 'C'), '0');
  assert.equal(expenseBalanceChange(expense, 'unrelated'), '0');
  assert.equal(expenseBalanceChange({ ...expense, deleted: true }, 'B'), '0');
});

test('Bill direction preserves largest-remainder paise allocation for equal and weighted splits', () => {
  const equal = validateExpense('100', { C: '100' }, { mode: 'equal', values: { A: '1', B: '1', C: '1' } }, ['A', 'B', 'C']);
  assert.deepEqual(['A', 'B', 'C'].map(id => expenseBalanceChange(equal, id)), ['-34', '-33', '67']);
  const weighted = validateExpense('101', { A: '20', B: '81' }, { mode: 'shares', values: { A: '1', B: '2', C: '0' } }, ['A', 'B', 'C']);
  assert.deepEqual(['A', 'B', 'C'].map(id => expenseBalanceChange(weighted, id)), ['-14', '14', '0']);
});

test('Bill direction reconciles allocated split fixtures and retains exact integer precision', () => {
  for (const fixture of fixtures.valid_expenses) {
    const expense = { paid: fixture.expected_paid, shares: fixture.expected_shares };
    const changes = fixture.participant_ids.map((id: string) => BigInt(expenseBalanceChange(expense, id)));
    assert.equal(changes.reduce((sum: bigint, change: bigint) => sum + change, 0n), 0n, fixture.id);
  }
  assert.equal(expenseBalanceChange({ paid: { A: '9007199254740993' }, shares: { A: '9007199254740992' } }, 'A'), '1');
  assert.equal(expenseBalanceChange({ paid: { A: '123' }, shares: { A: '123' } }, 'A'), '0');
});

test('Settlement cashflow is outgoing negative and incoming positive, opposite its debt adjustment', () => {
  const payment = { sender: 'A', recipient: 'B', amount: '12345' };
  assert.equal(settlementCashflow(payment, 'A'), '-12345');
  assert.equal(settlementCashflow(payment, 'B'), '12345');
  assert.equal(settlementCashflow(payment, 'unrelated'), '0');
  const balances = addSettlement({ A: '0', B: '0' }, payment.sender, payment.recipient, payment.amount);
  for (const id of ['A', 'B']) assert.equal(BigInt(settlementCashflow(payment, id)) + BigInt(balances[id]), 0n);
});

test('Reversed records have no cashflow and direction does not claim receipt confirmation', () => {
  for (const method of ['manual_record', 'recipient_confirmed', 'manual_then_confirmed']) {
    const payment = { sender: 'A', recipient: 'B', amount: '101', method };
    assert.equal(settlementCashflow(payment, 'A'), '-101');
    assert.equal(settlementCashflow(payment, 'B'), '101');
    assert.equal(settlementCashflow({ ...payment, reversed: true }, 'A'), '0');
    assert.equal(settlementCashflow({ ...payment, reversed: true }, 'B'), '0');
  }
  assert.equal(settlementCashflow({ sender: 'A', recipient: 'B', amount: '0' }, 'A'), '0');
  assert.equal(settlementCashflow({ sender: 'A', recipient: 'B', amount: '9007199254740993' }, 'A'), '-9007199254740993');
});
