import type { Group } from './types';

export function selfParticipant(group: Group, userId: string) {
  return group.participants.find(person => !person.removed && person.user_id != null && String(person.user_id) === userId);
}

/** Filter the complete canonical plan; never recalculate from a subset of people or bills. */
export function personalTransfers(group: Group, selfId: string) {
  if (!group.participants.some(person => person.id === selfId && !person.removed)) return [];
  return group.transfers.filter(transfer =>
    (transfer.sender === selfId || transfer.recipient === selfId)
    && transfer.sender !== transfer.recipient && BigInt(transfer.amount) > 0n
    && [transfer.sender, transfer.recipient].every(id => group.participants.some(person => person.id === id)));
}

export function personalSettlements(group: Group, selfId: string) {
  if (!group.participants.some(person => person.id === selfId && !person.removed)) return [];
  return group.settlements.filter(payment => payment.sender === selfId || payment.recipient === selfId);
}

/** Keep new contacts reachable, and never hide an obligation or a saved change. */
export function visiblePeopleSummary(group: Group, userId: string, hasPending = false): boolean {
  if (!group.is_direct) return false;
  const self = selfParticipant(group, userId);
  if (!self) return false;
  if (hasPending || BigInt(group.balances[self.id] ?? '0') !== 0n) return true;
  if (group.archived || !group.participants.some(person => person.id !== self.id && !person.removed)) return false;
  return !group.expenses.length && !group.settlements.length && !group.opening_balance
    && BigInt(group.totals?.spending ?? '0') === 0n
    && !group.history?.bills?.next_cursor && !group.history?.bills?.previous?.length
    && !group.history?.settlements?.next_cursor && !group.history?.settlements?.previous?.length;
}

/** Personal payment entry must include the signed-in active participant in either direction. */
export function isPersonalPayment(group: Group, selfId: string, sender: string, recipient: string): boolean {
  return sender !== recipient && (sender === selfId || recipient === selfId)
    && [selfId, sender, recipient].every(id => group.participants.some(person => person.id === id && !person.removed));
}
