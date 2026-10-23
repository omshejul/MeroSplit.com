import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyGroup, legacyMatchesServer, previewPending } from '../src/ledger.ts';
import { putLocalExpense, recalculateLocal } from './fixtures.ts';
import type { Command } from '../src/types.ts';

const original = putLocalExpense(emptyGroup('g', 'Trip', [{ id: 'A', name: 'A' }, { id: 'B', name: 'B' }]), {
  id: 'e', version: 1, description: 'Lunch', total: '10000', paid: { A: '10000' },
  split: { mode: 'equal', values: { A: '1', B: '1' } }, date: '2026-10-16', category: 'general', notes: '', deleted: false,
});
const command = (method: Command['method'], path: string, body: Command['body'] = {}): Command => ({
  command_id: path, group_id: 'g', method, path: `/groups/g${path}`, body, state: 'pending', error: null,
});

test('Pending bill reversal removes its balance once and retains the accepted original', () => {
  const reversal = command('POST', '/expenses/e/reverse', { version: 1 });
  const preview = previewPending(original, [reversal, reversal]);
  assert.deepEqual(preview.balances, { A: '0', B: '0' });
  assert.deepEqual(preview.expenses, [{ ...original.expenses[0], deleted: true }]);
  assert.equal(original.expenses[0].deleted, false);
  assert.deepEqual(original.balances, { A: '5000', B: '-5000' });
});

test('Old saved delete or restore commands cannot pretend to have accepted pending balances', () => {
  for (const legacy of [command('DELETE', '/expenses/e'), command('POST', '/expenses/e/restore')]) {
    assert.throws(() => previewPending(original, [legacy]), /until sync/);
    assert.equal(original.expenses[0].deleted, false);
    assert.deepEqual(original.balances, { A: '5000', B: '-5000' });
  }
});

test('Pending payment reversal undoes the posting once without changing accepted records', () => {
  const payment = command('POST', '/settlements', { id: 's', sender: 'B', recipient: 'A', amount: '5000' });
  const reversal = command('POST', '/settlements/s/reverse');
  assert.deepEqual(previewPending(original, [payment]).balances, { A: '0', B: '0' });
  const preview = previewPending(original, [payment, reversal, reversal]);
  assert.deepEqual(preview.balances, original.balances);
  assert.equal(preview.settlements[0].reversed, true);
  assert.deepEqual(original.settlements, []);
});

test('Opening and receipt acknowledgments explicitly withhold an unsupported pending total', () => {
  for (const path of ['/opening-balances/acknowledge', '/payment-attempts/p/confirm']) {
    assert.throws(() => previewPending(original, [command('POST', path)]), /accepted server result/);
  }
});

test('A local partial repayment can be reversed once while retaining its original record', () => {
  const paid = recalculateLocal({ ...original, settlements: [{ id: 'past', sender: 'B', recipient: 'A', amount: '1250', provenance: 'manual_record' }] });
  assert.deepEqual(paid.balances, { A: '3750', B: '-3750' });
  const reversed = recalculateLocal({ ...paid, settlements: paid.settlements.map(value => ({ ...value, reversed: true })) });
  assert.deepEqual(reversed.balances, { A: '5000', B: '-5000' });
  assert.deepEqual(recalculateLocal(reversed).balances, { A: '5000', B: '-5000' });
  assert.deepEqual(reversed.settlements, [{ id: 'past', sender: 'B', recipient: 'A', amount: '1250', provenance: 'manual_record', reversed: true }]);
  assert.equal(paid.settlements[0].reversed, undefined);
});

test('Legacy shadow comparison ignores revision counters, vector order and server-only bookkeeping', () => {
  const canonical = { ...original, version: 99, owner_id: 1, activity: ['accepted server history'], participants: [...original.participants].reverse().map(person => ({ ...person, user_id: person.id === 'A' ? 1 : null })), expenses: original.expenses.map(expense => ({ ...expense, version: 42, paid: { B: '0', A: '10000' } })) };
  assert.equal(legacyMatchesServer({ ...original, version: 1000 }, canonical), true);
  assert.equal(legacyMatchesServer(original, { ...canonical, expenses: canonical.expenses.map(expense => ({ ...expense, notes: 'Private edit still needs review' })) }), false);
  assert.equal(legacyMatchesServer(original, { ...canonical, participants: canonical.participants.map(person => ({ ...person, name: `${person.name} changed` })) }), false);
  assert.equal(legacyMatchesServer(original, { ...canonical, expenses: canonical.expenses.map(expense => ({ ...expense, deleted: true })) }), false);
});

test('Deleted bills, reversed payments and a recorded payment date cannot be discarded as a matching shadow', () => {
  const legacy = { ...original, expenses: original.expenses.map(expense => ({ ...expense, deleted: true })), settlements: [{ id: 'past', sender: 'B', recipient: 'A', amount: '1250', reversed: true }] };
  assert.equal(legacyMatchesServer(legacy, { ...legacy, expenses: [] }), false);
  assert.equal(legacyMatchesServer(legacy, { ...legacy, settlements: [] }), false);
  assert.equal(legacyMatchesServer(legacy, { ...legacy, settlements: legacy.settlements.map(row => ({ ...row, reversed: false })) }), false);
  assert.equal(legacyMatchesServer(legacy, { ...legacy, settlements: legacy.settlements.map(row => ({ ...row, date: '2026-10-17' })) }), true);
  assert.equal(legacyMatchesServer({ ...legacy, settlements: legacy.settlements.map(row => ({ ...row, date: '2026-10-16' })) }, { ...legacy, settlements: legacy.settlements.map(row => ({ ...row, date: '2026-10-17' })) }), false);
});

test('Canonical profile renames preserve matching recorded names without accepting a real ledger-person edit', () => {
  const canonical = { ...original, participants: original.participants.map(person => ({ ...person, recorded_name: person.name, name: person.id === 'A' ? 'New account display name' : person.name })) };
  assert.equal(legacyMatchesServer(original, canonical), true);
  assert.equal(legacyMatchesServer(original, { ...canonical, participants: canonical.participants.map(person => ({ ...person, recorded_name: `${person.recorded_name} changed` })) }), false);
  assert.equal(original.participants[0].name, 'A');
});
