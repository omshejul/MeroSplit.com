import { adjustmentToPaise, integer, MAX_AMOUNT, rupeesToPaise, validateExpense } from './accounting.ts';
import type { Split } from './accounting';
import { readDraft, saveDraft } from './storage.ts';
import type { Database } from './storage';
import type { Group } from './types';

export type ExpenseDefaults = { payerIds: string[]; participantIds: string[]; allParticipants: boolean; mode: Split['mode']; splitValues: Record<string, string> };
const key = (groupId: string) => `expense-defaults:${groupId}`;
export function defaultExpenseChoices(group: Group, selfId: string, saved?: ExpenseDefaults | null): ExpenseDefaults {
  const active = group.participants.filter(person => !person.removed).map(person => person.id);
  const included = (ids: string[]) => [...new Set(ids.filter(id => active.includes(id)))];
  const fallback = active.includes(selfId) ? selfId : active[0];
  const payers = saved ? included(saved.payerIds) : [];
  const participants = saved && !saved.allParticipants ? included(saved.participantIds) : active;
  const participantIds = participants.length ? participants : active;
  let mode = saved?.mode ?? 'equal';
  const splitValues = Object.fromEntries(participantIds.map(id => [id, saved?.splitValues[id] ?? (mode === 'shares' ? '1' : '')]));
  // Removing a person must not leave an invalid percentage preset on every new bill.
  if (mode === 'percent' && saved && (participantIds.some(id => !saved.participantIds.includes(id)) || saved.participantIds.some(id => !participantIds.includes(id)))) mode = 'equal';
  return { payerIds: payers.length ? payers : fallback ? [fallback] : [], participantIds, allParticipants: saved?.allParticipants ?? true, mode, splitValues };
}
export function validateExpenseDefaults(value: ExpenseDefaults): void {
  if (!value.payerIds.length) throw new Error('Choose someone who usually pays.');
  if (!value.participantIds.length) throw new Error('Choose who usually shares the bill.');
  if (value.mode === 'adjustment') {
    for (const id of value.participantIds) {
      const amount = integer(adjustmentToPaise(value.splitValues[id] || '0'), true);
      if (amount < -MAX_AMOUNT || amount > MAX_AMOUNT) throw new Error('Adjustment is outside the supported range.');
    }
    return;
  }
  const values = Object.fromEntries(value.participantIds.map(id => [id, value.mode === 'equal' ? '1' : value.mode === 'exact' ? integer(adjustmentToPaise(value.splitValues[id] || '0')).toString() : value.splitValues[id] ?? '']));
  const total = value.mode === 'exact' ? Object.values(values).reduce((sum, amount) => sum + integer(amount), 0n).toString() : '10000';
  validateExpense(total, { [value.participantIds[0]]: total }, { mode: value.mode, values }, value.participantIds);
}
export async function readExpenseDefaults(db: Database, owner: string, groupId: string): Promise<ExpenseDefaults | null> {
  const value = await readDraft<ExpenseDefaults>(db, owner, key(groupId));
  if (value === null) return null;
  if (!value || typeof value.allParticipants !== 'boolean' || !['equal', 'exact', 'percent', 'shares', 'adjustment'].includes(value.mode) ||
      ![value.payerIds, value.participantIds].every(ids => Array.isArray(ids) && ids.every(id => typeof id === 'string')) ||
      !value.splitValues || typeof value.splitValues !== 'object' || Array.isArray(value.splitValues) || Object.values(value.splitValues).some(item => typeof item !== 'string')) throw new Error('Could not read default settings.');
  return value;
}
export async function saveExpenseDefaults(db: Database, owner: string, groupId: string, value: ExpenseDefaults | null): Promise<void> {
  if (value) validateExpenseDefaults(value);
  await saveDraft(db, owner, key(groupId), value);
}
// Deterministic paise rounding, using the same equal split as the ledger.
export function defaultPayerAmounts(amount: string, payerIds: string[]): Record<string, string> {
  try {
    const total = rupeesToPaise(amount);
    const values = Object.fromEntries(payerIds.map(id => [id, '1']));
    const { shares } = validateExpense(total, { [payerIds[0]]: total }, { mode: 'equal', values }, payerIds);
    return Object.fromEntries(Object.entries(shares).map(([id, value]) => [id, `${BigInt(value) / 100n}.${(BigInt(value) % 100n).toString().padStart(2, '0')}`]));
  } catch { return {}; }
}
