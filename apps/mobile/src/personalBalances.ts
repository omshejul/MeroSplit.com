import type { Group } from './types';

export function selfParticipant(group: Group, userId: string) {
  return group.participants.find(person => !person.removed && person.user_id != null && String(person.user_id) === userId);
}

/** Direct ledgers display the other person, whichever member is signed in. */
export function groupDisplayName(group: Group, userId?: string): string {
  const self = userId ? selfParticipant(group, userId) : undefined;
  return group.is_direct && self ? group.participants.find(person => person.id !== self.id)?.name ?? group.name : group.name;
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

/** A settled balance never removes a contact. Only an explicit removal hides it. */
export function visiblePeopleSummary(group: Group, userId: string, hasPending = false): boolean {
  if (!group.is_direct) return false;
  const self = selfParticipant(group, userId);
  if (!self) return false;
  if (hasPending || BigInt(group.balances[self.id] ?? '0') !== 0n) return true;
  return !group.hidden && group.participants.some(person => person.id !== self.id);
}

/** Personal payment entry must include the signed-in active participant in either direction. */
export function isPersonalPayment(group: Group, selfId: string, sender: string, recipient: string): boolean {
  return sender !== recipient && (sender === selfId || recipient === selfId)
    && [selfId, sender, recipient].every(id => group.participants.some(person => person.id === id && !person.removed));
}
