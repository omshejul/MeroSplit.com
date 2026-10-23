import { accountOwner, request } from './api.ts';
import { readDraft, saveDraft, saveGroup } from './storage.ts';
import type { Database } from './storage.ts';
import type { Group, Session } from './types.ts';

export type SplitwisePreview = {
  source_hash: string; currency: 'INR'; members: string[]; expense_count: number; payment_count: number;
  balances: string[]; unresolved: { row: number; date: string; description: string; category: string; amount: string }[];
  warnings: string[]; duplicate_group: { id: string; name: string } | null;
};
export type SplitwiseImportRequest = {
  command_id: string; id: string; csv: string; name: string; self_index: number; payers: Record<string, number>;
};
export type SplitwiseImportReceipt = { id: string; version: number; already_imported: boolean };
export type SplitwiseImportResult = { group: Group; alreadyImported: boolean };
type Send = typeof request;
export const SPLITWISE_IMPORT_DRAFT = 'splitwise-import';

export function readPendingSplitwiseImport(db: Database, session: Session): Promise<SplitwiseImportRequest | null> {
  return readDraft<SplitwiseImportRequest>(db, accountOwner(session), SPLITWISE_IMPORT_DRAFT);
}

// Freeze the complete request before the first write. Restart and retry always
// send these same IDs and choices, even when a response was lost after acceptance.
export async function startSplitwiseImport(db: Database, session: Session, body: SplitwiseImportRequest): Promise<void> {
  const owner = accountOwner(session), snapshot = JSON.parse(JSON.stringify(body)) as SplitwiseImportRequest;
  await db.withExclusiveTransactionAsync(async tx => {
    const pending = await readPendingSplitwiseImport(tx, session);
    if (pending && JSON.stringify(pending) !== JSON.stringify(snapshot)) throw new Error('Finish the saved import before choosing another file.');
    await saveDraft(tx, owner, SPLITWISE_IMPORT_DRAFT, snapshot);
  });
}

export async function retrySplitwiseImport(db: Database, session: Session, send: Send = request): Promise<SplitwiseImportResult> {
  const owner = accountOwner(session), pending = await readPendingSplitwiseImport(db, session);
  if (!pending) throw new Error('There is no saved import to retry.');
  const receipt = await send<SplitwiseImportReceipt>(session, '/imports/splitwise', 'POST', pending);
  const group = await send<Group>(session, `/groups/${receipt.id}/summary`);
  if (group.id !== receipt.id) throw new Error('The imported group could not be read. Retry to recover your saved import.');
  await db.withExclusiveTransactionAsync(async tx => {
    await saveGroup(tx, owner, group, 'shared');
    await tx.runAsync('DELETE FROM drafts WHERE owner=? AND group_id=? AND body=?', owner, SPLITWISE_IMPORT_DRAFT, JSON.stringify(pending));
  });
  return { group, alreadyImported: receipt.already_imported };
}
