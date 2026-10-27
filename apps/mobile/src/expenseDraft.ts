import { readDraft, saveDraft } from './storage.ts';
import type { Database } from './storage.ts';
import type { ExpenseFormDraft } from './ExpenseForm';

export function expenseDraftStore(owner: string, groupId: string, expenseId: string | null, writes: { current: Promise<void> }, database: () => Promise<Database>) {
  const key = expenseId ? `expense-edit:${groupId}:${expenseId}` : groupId;
  let revision = 0;
  return {
    async read(): Promise<ExpenseFormDraft | null> {
      const current = revision;
      await writes.current;
      const saved = await readDraft<ExpenseFormDraft>(await database(), owner, key);
      if (current !== revision || !saved) return null;
      if (saved.schemaVersion !== 1 || saved.groupId !== groupId || saved.expenseId !== expenseId ||
          typeof saved.id !== 'string' || !saved.id || typeof saved.expenseVersion !== 'number' ||
          !['description', 'amount', 'date', 'notes'].every(field => typeof saved[field as keyof ExpenseFormDraft] === 'string') ||
          !['equal', 'exact', 'percent', 'shares'].includes(saved.mode) ||
          ![saved.payerIds, saved.participantIds].every(ids => Array.isArray(ids) && ids.every(id => typeof id === 'string')) ||
          ![saved.payerAmounts, saved.splitValues].every(values => values && typeof values === 'object' && !Array.isArray(values) && Object.values(values).every(value => typeof value === 'string')) ||
          saved.attachment && (saved.attachment.path !== `/groups/${groupId}/expenses/${saved.id}/attachments` || typeof saved.attachment.file?.uri !== 'string')) {
        throw new Error('Could not restore this saved bill. Your draft is still on this device.');
      }
      return saved;
    },
    write(draft: ExpenseFormDraft | null): Promise<void> {
      const current = ++revision, snapshot = draft ? JSON.parse(JSON.stringify(draft)) as ExpenseFormDraft : null;
      // Serialise account transitions and discard behind earlier writes. Only the latest revision may persist.
      const pending = writes.current.catch(() => {}).then(async () => {
        const db = await database();
        if (current === revision) await saveDraft(db, owner, key, snapshot);
      });
      writes.current = pending;
      return pending;
    },
  };
}
