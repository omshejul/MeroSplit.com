import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyGroup, previewPending, putLocalExpense } from '../src/ledger.ts';
import type { Command } from '../src/types.ts';

const original = putLocalExpense(emptyGroup('g', 'Trip', [{ id: 'A', name: 'A' }, { id: 'B', name: 'B' }]), {
  id: 'e', version: 1, description: 'Lunch', total: '10000', paid: { A: '10000' },
  split: { mode: 'equal', values: { A: '1', B: '1' } }, date: '2026-10-16', category: 'general', notes: '', deleted: false,
});
const command = (method: Command['method'], path: string, body: Command['body'] = {}): Command => ({
  command_id: path, group_id: 'g', method, path: `/groups/g${path}`, body, state: 'pending', error: null,
});

test('Pending delete and restore preserve accepted records and restore the exact balance', () => {
  const deletion = command('DELETE', '/expenses/e'), restoration = command('POST', '/expenses/e/restore');
  assert.deepEqual(previewPending(original, [deletion]).balances, { A: '0', B: '0' });
  const preview = previewPending(original, [deletion, restoration, restoration]);
  assert.deepEqual(preview.balances, original.balances);
  assert.equal(preview.expenses[0].deleted, false);
  assert.equal(original.expenses[0].deleted, false);
  assert.deepEqual(original.balances, { A: '5000', B: '-5000' });
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
