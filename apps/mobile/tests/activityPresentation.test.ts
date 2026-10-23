import test from 'node:test';
import assert from 'node:assert/strict';
import { activityDay, activityPresentation, activityTime, paymentPresentation } from '../src/activityPresentation.ts';
import type { ActivityItem } from '../src/types.ts';

const person = (id: string, is_self = false) => ({ id, name: id === 'self' ? 'Canonical name' : id, is_self });
const event = (kind: ActivityItem['kind'] = 'payment_recorded'): ActivityItem => ({
  id: 'event', kind, created_at: '2026-10-17T12:00:00+05:30', group: { id: 'group', name: 'Trip' },
  actor: { name: 'Canonical name', is_self: true },
  payment: { id: 'record', sender: person('self', true), recipient: person('Asha'), amount: '334', reversed: false },
});

test('actual payment directions use signed-in participant identity, including third-party neutrality', () => {
  const name = (id: string) => id === 'self' ? 'You' : id;
  const payment = { id: 'record', sender: 'self', recipient: 'Asha', amount: '334' };
  assert.deepEqual(paymentPresentation(payment, 'self', name), { title: 'You paid Asha', cashflow: '-334', status: 'Receipt unconfirmed' });
  assert.equal(paymentPresentation({ ...payment, sender: 'Asha', recipient: 'self', method: 'recipient_confirmed' }, 'self', name).cashflow, '334');
  assert.equal(paymentPresentation({ ...payment, sender: 'Other' }, 'self', name).cashflow, '0');
  assert.equal(paymentPresentation({ ...payment, reversed: true }, 'self', name).cashflow, '0');
  assert.equal(paymentPresentation({ ...payment, reversed: true }, 'self', name).status, 'Record reversed');
});

test('activity payment labels and canonical destinations preserve outgoing, incoming and unrelated perspectives', () => {
  const outgoing = activityPresentation(event());
  assert.equal(outgoing.title, 'You paid Asha');
  assert.equal(outgoing.cashflow, '-334');
  assert.equal(outgoing.amount, '334');
  assert.deepEqual(outgoing.target, { kind: 'payment', groupId: 'group', settlementId: 'record' });
  const incoming = event(); incoming.payment!.sender = person('Asha'); incoming.payment!.recipient = person('self', true);
  assert.equal(activityPresentation(incoming).title, 'Asha paid you');
  assert.equal(activityPresentation(incoming).cashflow, '334');
  const unrelated = event(); unrelated.payment!.sender = person('Other');
  assert.equal(activityPresentation(unrelated).title, 'Other paid Asha');
  assert.equal(activityPresentation(unrelated).cashflow, '0');
});

test('reversal events and a later-reversed payment stay neutral without describing a bank refund', () => {
  const reversal = activityPresentation(event('payment_reversed'));
  assert.equal(reversal.title, 'You reversed a payment record');
  assert.equal(reversal.cashflow, '0');
  const original = event(); original.payment!.reversed = true;
  assert.equal(activityPresentation(original).cashflow, '0');
});

test('bill and member events use readable actions without fabricating money or claim state', () => {
  const bill: ActivityItem = { ...event('bill_edited'), payment: undefined, bill: { id: 'bill', description: 'Very long lunch name', deleted: false } };
  const row = activityPresentation(bill);
  assert.equal(row.title, 'You edited Very long lunch name');
  assert.equal(row.amount, undefined);
  assert.deepEqual(row.target, { kind: 'bill', groupId: 'group', expenseId: 'bill' });
  const added: ActivityItem = { ...event('member_added'), payment: undefined, person: person('Noor') };
  assert.equal(activityPresentation(added).title, 'You added Noor');
  assert.deepEqual(activityPresentation(added).target, { kind: 'group', groupId: 'group' });
  assert.equal(activityPresentation({ ...added, kind: 'member_joined', person: person('self', true) }).title, 'You joined the group');
});

test('date headings use local calendar days and keep malformed dates honest', () => {
  const now = new Date(2026, 9, 17, 10);
  assert.equal(activityDay(new Date(2026, 9, 17, 1).toISOString(), now), 'Today');
  assert.equal(activityDay(new Date(2026, 9, 16, 23).toISOString(), now), 'Yesterday');
  assert.equal(activityDay('unknown', now), 'Date unavailable');
  assert.equal(activityTime('unknown'), 'Time unavailable');
  assert.match(activityDay(new Date(2025, 9, 15).toISOString(), now), /2025/);
});
