import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateExpense, proposeTransfers, addExpense, addSettlement, rupeesToPaise, formatMoney } from '../src/accounting.ts';
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
