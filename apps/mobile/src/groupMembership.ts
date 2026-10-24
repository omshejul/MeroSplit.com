import { accountOwner, syncOutbox } from './api.ts';
import { enqueue, pendingCommands } from './storage.ts';
import type { Database, MembershipReceipt } from './storage.ts';
import type { Session } from './types';

// The caller owns its existing action lock and account guard. Flush draft writes
// before changing access; never discard those drafts, including after departure.
export async function changeGroupMembership(
  db: Database, session: Session, groupId: string, action: 'leave' | 'restore',
  options: { isOnline: () => boolean; flushDrafts: () => Promise<void>; uuid: () => string },
): Promise<MembershipReceipt> {
  await options.flushDrafts();
  if (!options.isOnline()) throw new Error('Connect to the internet before changing group membership.');
  const owner = accountOwner(session), path = `/groups/${groupId}/${action}`;
  const pending = await pendingCommands(db, owner);
  const existingIndex = pending.findIndex(command => command.group_id === groupId && command.method === 'POST' && command.path === path);
  if (existingIndex >= 0) {
    const receipts = await syncOutbox(db, session, 'summary', pending[existingIndex].command_id);
    const receipt = receipts[existingIndex] as MembershipReceipt;
    // Finish an old installed client's hide request before the new explicit
    // Delete group action. Never rewrite its immutable command ID or body.
    if (action !== 'leave' || pending[existingIndex].body.remove_membership === true || receipt.disposition !== 'hidden') return receipt;
  }
  await syncOutbox(db, session, 'summary');
  if (!options.isOnline()) throw new Error('Connect to the internet before changing group membership.');
  const command_id = options.uuid();
  await enqueue(db, owner, { command_id, group_id: groupId, method: 'POST', path, body: { command_id, ...(action === 'leave' ? { remove_membership: true } : {}) }, state: 'pending', error: null });
  const receipts = await syncOutbox(db, session, 'summary', command_id);
  return receipts[0] as MembershipReceipt;
}
