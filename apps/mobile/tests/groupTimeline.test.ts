import test from 'node:test';
import assert from 'node:assert/strict';
import { cachedTimeline } from '../src/groupTimeline.ts';
import type { Group } from '../src/types.ts';

const bill = (id: string, date = '2026-10-28', created_at = '2026-10-28T12:00:00+00:00') => ({ id, version: 1, description: 'Lunch', notes: '', date, created_at });
const payment = (id: string, date: string | null = '2026-10-28', created_at = '2026-10-28T12:00:00Z') => ({ id, sender: 'a', recipient: 'b', amount: '100', date, created_at });
const identities = (group: Group) => cachedTimeline(group).map(row => `${row.kind}:${row.kind === 'bill' ? row.bill.id : row.payment.id}`);

test('complete cache ordering matches server dates, creation microseconds, payment/bill ties and descending IDs', () => {
  const group = { expenses: [bill('a'), bill('z'), bill('micro', '2026-10-28', '2026-10-28T12:00:00.000001+00:00'), bill('new-day', '2026-10-29')],
    settlements: [payment('a'), payment('z'), payment('undated', null, '2026-10-30T12:00:00Z'), payment('earlier-undated', null, '2026-10-29T12:00:00Z')] } as Group;
  const before = JSON.stringify(group);
  assert.deepEqual(identities(group), ['bill:new-day', 'bill:micro', 'payment:z', 'payment:a', 'bill:z', 'bill:a', 'payment:undated', 'payment:earlier-undated']);
  assert.equal(JSON.stringify(group), before, 'reading a timeline cannot change accepted balances or cached record order');
});

test('new pending payments stay visible before accepted records on the same day and keep their pending provenance', () => {
  const pending = { ...payment('pending'), created_at: undefined, provenance: 'pending_manual' };
  const group = { expenses: [bill('accepted')], settlements: [pending] } as Group;
  assert.deepEqual(identities(group), ['payment:pending', 'bill:accepted']);
  const first = cachedTimeline(group)[0];
  assert.equal(first.kind === 'payment' && first.payment.provenance, 'pending_manual');
});
