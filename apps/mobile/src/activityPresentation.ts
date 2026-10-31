import { settlementCashflow } from './accounting.ts';
import type { ActivityItem, ActivityTarget, Settlement } from './types.ts';

/** Cash direction describes a recorded payment; reversal never claims a bank refund. */
export function paymentPresentation(payment: Settlement, selfId: string, name: (id: string) => string) {
  const title = payment.sender === selfId ? `You paid ${name(payment.recipient)}`
    : payment.recipient === selfId ? `${name(payment.sender)} paid you`
      : `${name(payment.sender)} paid ${name(payment.recipient)}`;
  return { title, cashflow: settlementCashflow(payment, selfId), status: payment.reversed ? 'Record reversed'
    : ['recipient_confirmed', 'manual_then_confirmed'].includes(payment.method ?? '') ? 'Recipient confirmed' : '' };
}

export function activityPresentation(item: ActivityItem) {
  const actor = item.actor?.is_self ? 'You' : item.actor?.name || 'Someone';
  const person = item.person?.is_self ? 'You' : item.person?.name || 'A person';
  const target: ActivityTarget = item.bill ? { kind: 'bill', groupId: item.group.id, expenseId: item.bill.id }
    : item.payment ? { kind: 'payment', groupId: item.group.id, settlementId: item.payment.id }
      : { kind: 'group', groupId: item.group.id };
  let title: string;
  switch (item.kind) {
    case 'bill_added': title = `${actor} added ${item.bill?.description || 'a bill'}`; break;
    case 'bill_edited': title = `${actor} edited ${item.bill?.description || 'a bill'}`; break;
    case 'bill_deleted': title = `${actor} deleted ${item.bill?.description || 'a bill'}`; break;
    case 'bill_restored': title = `${actor} restored ${item.bill?.description || 'a bill'}`; break;
    case 'bill_reversed': title = `${actor} reversed ${item.bill?.description || 'a bill'}`; break;
    case 'payment_recorded': title = item.payment ? item.payment.sender.is_self ? `You paid ${item.payment.recipient.name}`
      : item.payment.recipient.is_self ? `${item.payment.sender.name} paid you`
        : `${item.payment.sender.name} paid ${item.payment.recipient.name}` : `${actor} recorded a payment`; break;
    case 'payment_reversed': title = `${actor} reversed a payment record`; break;
    case 'member_added': title = `${actor} added ${item.person?.is_self ? 'you' : person}`; break;
    case 'member_joined': title = `${person} joined the group`; break;
    case 'member_removed': title = `${actor} removed ${item.person?.is_self ? 'you' : person}`; break;
    case 'simplify_debts_changed': title = `${actor} changed Simplify debts`; break;
    case 'group_created': title = `${actor} created the group`; break;
    case 'group_archived': title = `${actor} archived the group`; break;
    case 'group_unarchived': title = `${actor} reopened the group`; break;
  }
  const cashflow = item.kind !== 'payment_recorded' || !item.payment || item.payment.reversed ? '0'
    : ((item.payment.recipient.is_self ? 1n : 0n) - (item.payment.sender.is_self ? 1n : 0n)) * BigInt(item.payment.amount);
  const icon = item.kind.startsWith('bill_') ? 'bill' : item.kind === 'payment_reversed' ? 'refresh' : item.kind.startsWith('payment_') ? 'pay'
    : item.kind === 'member_removed' ? 'remove' : item.kind.startsWith('member_') ? 'personAdd' : 'groups';
  return { title, target, cashflow: String(cashflow), amount: item.payment?.amount, icon } as const;
}

export function activityDay(value: string, now = new Date()) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Date unavailable';
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return 'Today';
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', ...(date.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
}

export function activityTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Time unavailable' : date.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
}
