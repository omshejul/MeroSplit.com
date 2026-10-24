import { readDraft, saveDraft } from './storage.ts';
import type { Database } from './storage.ts';

export type StatementDelivery = { id: string; command_id: string | null; state: string; error: string };
const key = 'balance-statement-request';
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

export async function sendStatementRequest(db: Database, owner: string, createId: () => string, send: (commandId: string) => Promise<StatementDelivery>): Promise<StatementDelivery> {
  let commandId = '';
  await db.withExclusiveTransactionAsync(async tx => {
    commandId = await readDraft<string>(tx, owner, key) ?? createId();
    if (!uuid.test(commandId)) throw new Error('The saved statement request is unreadable. Export your data before clearing local data.');
    await saveDraft(tx, owner, key, commandId);
  });
  const receipt = await send(commandId);
  if (!receipt || receipt.command_id !== commandId || !uuid.test(receipt.id)
    || !['pending', 'sending', 'accepted', 'held', 'cancelled', 'failed'].includes(receipt.state) || typeof receipt.error !== 'string') {
    throw new Error('Could not confirm this request. Try again to check the saved request.');
  }
  await db.withExclusiveTransactionAsync(async tx => {
    if (await readDraft<string>(tx, owner, key) === commandId) await saveDraft(tx, owner, key, null);
  });
  return receipt;
}
