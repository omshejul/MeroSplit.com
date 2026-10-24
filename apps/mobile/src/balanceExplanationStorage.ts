import { accountOwner, ApiError, fetchGroup } from './api.ts';
import { readGroup, saveGroup, type Database } from './storage.ts';
import { changedBalance } from './balanceExplanation.ts';
import type { Group, Session } from './types.ts';

export type BalanceSource = { group: Group; saved: boolean };

/** Only GET a complete authorized group. Cache is account-scoped; never replay outbox commands here. */
export async function loadBalanceSource(db: Database, session: Session, expected: Group, isCurrent: () => boolean, fetch: typeof fetchGroup = fetchGroup): Promise<BalanceSource> {
  const owner = accountOwner(session), current = () => { if (!isCurrent()) throw new Error('This account changed. Reopen the group.'); };
  current();
  const cached = await readGroup(db, owner, expected.id);
  current();
  const sameSnapshot = (value: Group) => value.id === expected.id && value.version === expected.version && value.read_mode !== 'summary';
  if (cached?.kind === 'local' && expected.version === 0 && sameSnapshot(cached.group)) { current(); return { group: cached.group, saved: true }; }
  let group: Group;
  try { group = await fetch(session, expected.id, 'full'); }
  catch (error) {
    current();
    if (error instanceof ApiError && error.status < 500) throw error;
    if (cached?.kind === 'shared' && sameSnapshot(cached.group)) return { group: cached.group, saved: true };
    throw new Error('Connect to load the full breakdown. The saved total is still available on the group page.');
  }
  current();
  if (!sameSnapshot(group)) throw new Error(changedBalance);
  try { await saveGroup(db, owner, group, 'shared'); } catch { /* A readable online snapshot does not require a successful cache write. */ }
  current();
  return { group, saved: false };
}
