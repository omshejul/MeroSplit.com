import type { CachedGroup, Command, Group, LegacyRecovery, LegacySource } from './types';
import type { ExpenseHistoryPage } from './expenseHistory';

type Bind = string | number | null;
// Small seam for native SQLite and the real SQLite adapter used by Node tests.
export interface Database {
  execAsync(sql: string): Promise<void>;
  runAsync(sql: string, ...params: Bind[]): Promise<unknown>;
  getFirstAsync<T>(sql: string, ...params: Bind[]): Promise<T | null>;
  getAllAsync<T>(sql: string, ...params: Bind[]): Promise<T[]>;
  withExclusiveTransactionAsync(task: (transaction: Database) => Promise<void>): Promise<void>;
}

// total_changes covers this connection; data_version covers native exclusive
// transactions that commit through a separate SQLite connection.
export async function storageRevision(db: Database): Promise<string> {
  const [own, other] = await Promise.all([
    db.getFirstAsync<{ n: number }>('SELECT total_changes() AS n'),
    db.getFirstAsync<{ data_version: number }>('PRAGMA data_version'),
  ]);
  return `${own?.n ?? 0}:${other?.data_version ?? 0}`;
}

export async function migrate(db: Database): Promise<void> {
  const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  if ((row?.user_version ?? 0) > 6) throw new Error('This database needs a newer app.');
  if (row?.user_version === 6) return;
  await db.withExclusiveTransactionAsync(async tx => {
    await tx.execAsync(`
      CREATE TABLE IF NOT EXISTS groups_cache (
        owner TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL,
        snapshot TEXT NOT NULL, PRIMARY KEY(owner, id)
      );
      CREATE TABLE IF NOT EXISTS outbox (
        ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
        owner TEXT NOT NULL, command_id TEXT NOT NULL, group_id TEXT NOT NULL,
        method TEXT NOT NULL, path TEXT NOT NULL, body TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending', error TEXT,
        UNIQUE(owner, command_id)
      );
      CREATE TABLE IF NOT EXISTS drafts (
        owner TEXT NOT NULL, group_id TEXT NOT NULL, body TEXT NOT NULL,
        PRIMARY KEY(owner, group_id)
      );
      CREATE TABLE IF NOT EXISTS group_summaries (
        owner TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL,
        snapshot TEXT NOT NULL, PRIMARY KEY(owner, id)
      );
      CREATE TABLE IF NOT EXISTS sync_state (owner TEXT PRIMARY KEY, confirmed_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS expense_history (
        owner TEXT NOT NULL, group_id TEXT NOT NULL, expense_id TEXT NOT NULL,
        version INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(owner,group_id,expense_id)
      );
      DELETE FROM sync_state;
      PRAGMA user_version = 6;
    `);
    const columns = await tx.getAllAsync<{ name: string }>('PRAGMA table_info(outbox)');
    if (!columns.some(column => column.name === 'base_version')) await tx.execAsync('ALTER TABLE outbox ADD COLUMN base_version INTEGER;');
    if (!columns.some(column => column.name === 'attempted')) await tx.execAsync('ALTER TABLE outbox ADD COLUMN attempted INTEGER NOT NULL DEFAULT 0;');
    // Older queues did not distinguish unsent writes from lost server responses.
    if ((row?.user_version ?? 0) < 5) await tx.runAsync('UPDATE outbox SET attempted=1');
  });
}

export async function saveGroup(db: Database, owner: string, group: Group, kind: CachedGroup['kind']): Promise<void> {
  const previous = await db.getFirstAsync<{ version: number | null }>("SELECT MAX(version) AS version FROM (SELECT json_extract(snapshot,'$.version') AS version FROM groups_cache WHERE owner=? AND id=? UNION ALL SELECT json_extract(snapshot,'$.version') FROM group_summaries WHERE owner=? AND id=?)", owner, group.id, owner, group.id);
  const table = group.read_mode === 'summary' ? 'group_summaries' : 'groups_cache';
  await db.runAsync(`INSERT INTO ${table}(owner,id,kind,snapshot) VALUES(?,?,?,?) ON CONFLICT(owner,id) DO UPDATE SET kind=excluded.kind,snapshot=excluded.snapshot WHERE json_extract(${table}.snapshot,'$.version') <= json_extract(excluded.snapshot,'$.version') AND (${table}.kind<>excluded.kind OR ${table}.snapshot<>excluded.snapshot)`, owner, group.id, kind, JSON.stringify(group));
  await db.runAsync('DELETE FROM expense_history WHERE owner=? AND group_id=? AND version<?', owner, group.id, group.version);
  if (previous?.version !== group.version) await db.runAsync('DELETE FROM sync_state WHERE owner=?', owner);
  // A newer authoritative version invalidates all old history, including redacted text.
  if (group.read_mode === 'summary') {
    const complete = await db.getFirstAsync<{ id: string }>("SELECT id FROM groups_cache WHERE owner=? AND id=? AND kind='shared' AND json_extract(snapshot,'$.version') >= ?", owner, group.id, group.version);
    if (!complete) await db.runAsync('DELETE FROM sync_state WHERE owner=?', owner);
    await db.runAsync("DELETE FROM groups_cache WHERE owner=? AND id=? AND json_extract(snapshot,'$.version') < ?", owner, group.id, group.version);
  }
}

export async function saveDraft(db: Database, owner: string, groupId: string, draft: unknown): Promise<void> {
  await db.runAsync('INSERT INTO drafts(owner,group_id,body) VALUES(?,?,?) ON CONFLICT(owner,group_id) DO UPDATE SET body=excluded.body', owner, groupId, JSON.stringify(draft));
}

export async function readDraft<T>(db: Database, owner: string, groupId: string): Promise<T | null> {
  const row = await db.getFirstAsync<{ body: string }>('SELECT body FROM drafts WHERE owner=? AND group_id=?', owner, groupId);
  return row ? JSON.parse(row.body) as T : null;
}

// A bounded browsing snapshot never overwrites the complete legacy/recovery cache.
// Select the latest row in SQLite so an old large complete snapshot is not parsed.
const visibleGroups = `WITH snapshots AS (
  SELECT id,kind,snapshot,0 AS priority FROM groups_cache WHERE owner=?
  UNION ALL SELECT id,kind,snapshot,1 AS priority FROM group_summaries WHERE owner=?
), ranked AS (SELECT *,row_number() OVER (PARTITION BY id ORDER BY json_extract(snapshot,'$.version') DESC,priority DESC) AS rank FROM snapshots)
SELECT id,kind,snapshot FROM ranked WHERE rank=1`;

export async function listGroups(db: Database, owner: string): Promise<CachedGroup[]> {
  const rows = await db.getAllAsync<{ kind: CachedGroup['kind']; snapshot: string }>(`${visibleGroups} AND kind<>'unavailable' ORDER BY id`, owner, owner);
  return rows.map(row => ({ kind: row.kind, group: JSON.parse(row.snapshot) as Group }));
}

export async function listUnavailableGroups(db: Database, owner: string): Promise<Group[]> {
  const rows = await db.getAllAsync<{ snapshot: string }>(`${visibleGroups} AND kind='unavailable' ORDER BY id`, owner, owner);
  return rows.map(row => JSON.parse(row.snapshot) as Group);
}

export async function readVisibleGroup(db: Database, owner: string, id: string): Promise<CachedGroup | null> {
  const row = await db.getFirstAsync<{ kind: CachedGroup['kind']; snapshot: string }>(`${visibleGroups} AND id=?`, owner, owner, id);
  return row ? { kind: row.kind, group: JSON.parse(row.snapshot) as Group } : null;
}

export async function groupCacheHeads(db: Database, owner: string): Promise<Map<string, { kind: string; version: number }>> {
  const rows = await db.getAllAsync<{ id: string; kind: string; version: number }>(`SELECT id,kind,json_extract(snapshot,'$.version') AS version FROM (${visibleGroups})`, owner, owner);
  return new Map(rows.map(row => [row.id, { kind: row.kind, version: row.version }]));
}

// Only call after the index and every listed snapshot were fetched successfully.
// A failed refresh must not interpret a partial result as revoked access.
export type MembershipReceipt = { id: string; version: number; disposition: 'left' | 'hidden' | 'restored' };
export type AcceptedMembership = { commandId: string; receipt: MembershipReceipt };

export async function reconcileGroupCache(db: Database, owner: string, authorized: Group[], acceptedMembership?: AcceptedMembership, current: () => boolean = () => true, before?: Awaited<ReturnType<typeof groupCacheHeads>>): Promise<string[]> {
  const visible = new Set(authorized.map(group => group.id)), unavailable: string[] = [];
  if (visible.size !== authorized.length) throw new Error('The group refresh was incomplete. Try again.');
  await db.withExclusiveTransactionAsync(async tx => {
    if (!current()) throw new Error('The signed-in account changed.');
    if (acceptedMembership) {
      const { commandId, receipt } = acceptedMembership;
      const command = (await pendingCommands(tx, owner)).find(row => row.command_id === commandId);
      const action = receipt.disposition === 'restored' ? 'restore' : 'leave';
      const group = authorized.find(row => row.id === receipt.id);
      if (!command || command.state !== 'pending' || command.method !== 'POST' || command.group_id !== receipt.id
        || command.path !== `/groups/${receipt.id}/${action}` || command.body.command_id !== commandId
        || !(Object.keys(command.body).length === 1 || action === 'leave' && Object.keys(command.body).length === 2 && command.body.remove_membership === true)
        || command.body.remove_membership === true && receipt.disposition !== 'left'
        || !Number.isSafeInteger(receipt.version) || receipt.version < 0 || !['left', 'hidden', 'restored'].includes(receipt.disposition)
        || (receipt.disposition === 'left' ? !!group : !group || group.version < receipt.version || !!group.hidden !== (receipt.disposition === 'hidden'))) {
        throw new Error('The membership update could not be confirmed. Try again.');
      }
      await discardCommand(tx, owner, commandId);
    }
    for (const group of authorized) await saveGroup(tx, owner, group, 'shared');
    const queued = await pendingCommands(tx, owner);
    const cached = await tx.getAllAsync<{ id: string; kind: string; snapshot: string }>(visibleGroups, owner, owner);
    for (const row of cached) {
      if (visible.has(row.id)) continue;
      const commands = queued.filter(command => command.group_id === row.id), group = JSON.parse(row.snapshot) as Group;
      // A read started before this accepted change cannot revoke its cache.
      const previous = before?.get(row.id);
      if (before && (!previous || previous.kind !== row.kind || previous.version !== group.version)) continue;
      if (group.version === 0 && commands.some(command => command.method === 'POST' && command.path === '/groups' && command.body.id === row.id)) continue;
      await tx.runAsync('DELETE FROM expense_history WHERE owner=? AND group_id=?', owner, row.id);
      await tx.runAsync('DELETE FROM sync_state WHERE owner=?', owner);
      const keep = commands.length || await readDraft(tx, owner, row.id) != null || await readLegacyRecovery(tx, owner, row.id);
      for (const table of ['groups_cache', 'group_summaries']) {
        if (keep) await tx.runAsync(`UPDATE ${table} SET kind='unavailable' WHERE owner=? AND id=?`, owner, row.id);
        else await tx.runAsync(`DELETE FROM ${table} WHERE owner=? AND id=?`, owner, row.id);
      }
      if (row.kind !== 'unavailable') unavailable.push(row.id);
    }
    if (!current()) throw new Error('The signed-in account changed.');
  });
  return unavailable;
}

export async function readGroup(db: Database, owner: string, id: string): Promise<CachedGroup | null> {
  const row = await db.getFirstAsync<{ kind: CachedGroup['kind']; snapshot: string }>('SELECT kind,snapshot FROM groups_cache WHERE owner=? AND id=?', owner, id);
  return row ? { kind: row.kind, group: JSON.parse(row.snapshot) as Group } : null;
}

export async function enqueue(db: Database, owner: string, command: Command): Promise<void> {
  const existing = await db.getFirstAsync<{ body: string; path: string; method: string }>('SELECT body,path,method FROM outbox WHERE owner=? AND command_id=?', owner, command.command_id);
  const body = JSON.stringify(command.body);
  if (existing) {
    if (existing.body !== body || existing.path !== command.path || existing.method !== command.method) throw new Error('A command ID cannot be reused for different data.');
    return;
  }
  await db.runAsync('INSERT INTO outbox(owner,command_id,group_id,method,path,body,state,error,base_version) VALUES(?,?,?,?,?,?,?,?,?)', owner, command.command_id, command.group_id, command.method, command.path, body, command.state, command.error, command.base_version ?? null);
}

export async function pendingCommands(db: Database, owner: string): Promise<Command[]> {
  const rows = await db.getAllAsync<Omit<Command, 'body'> & { body: string }>('SELECT command_id,group_id,method,path,body,state,error,base_version,attempted FROM outbox WHERE owner=? ORDER BY ordinal', owner);
  return rows.map(({ base_version, attempted, ...row }) => ({ ...row, ...(attempted ? { attempted: true } : {}), body: JSON.parse(row.body) as Command['body'], ...(base_version == null ? {} : { base_version }) }));
}

export async function markCommand(db: Database, owner: string, id: string, state: Command['state'], error: string): Promise<void> {
  await db.runAsync('UPDATE outbox SET state=?,error=? WHERE owner=? AND command_id=?', state, error, owner, id);
}

export async function discardCommand(db: Database, owner: string, id: string): Promise<void> {
  await db.runAsync('DELETE FROM outbox WHERE owner=? AND command_id=?', owner, id);
}

export async function discardUnsentGroup(db: Database, owner: string, groupId: string): Promise<void> {
  await db.withExclusiveTransactionAsync(async tx => {
    const cached = await readGroup(tx, owner, groupId);
    const creation = await tx.getFirstAsync<{ command_id: string }>(
      "SELECT command_id FROM outbox WHERE owner=? AND group_id=? AND method='POST' AND path='/groups' AND json_extract(body,'$.id')=? LIMIT 1",
      owner, groupId, groupId,
    );
    if (cached?.kind !== 'shared' || cached.group.version !== 0 || !creation) {
      throw new Error('Only an unsynced new group can be discarded. Refresh this group before trying again.');
    }
    await tx.runAsync('DELETE FROM outbox WHERE owner=? AND group_id=?', owner, groupId);
    await tx.runAsync('DELETE FROM drafts WHERE owner=? AND group_id=?', owner, groupId);
    await tx.runAsync('DELETE FROM groups_cache WHERE owner=? AND id=?', owner, groupId);
  });
}

export async function replaceCommand(db: Database, owner: string, previousId: string, command: Command): Promise<void> {
  await db.withExclusiveTransactionAsync(async tx => {
    await discardCommand(tx, owner, previousId);
    await enqueue(tx, owner, command);
  });
}

export async function acceptCommand(db: Database, owner: string, id: string, group: Group): Promise<void> {
  await db.withExclusiveTransactionAsync(async tx => {
    await saveGroup(tx, owner, group, 'shared');
    await discardCommand(tx, owner, id);
  });
}

export async function createPendingGroup(db: Database, owner: string, group: Group, commands: Command[]): Promise<void> {
  if (!owner || owner === 'local') throw new Error('Sign in before creating a group.');
  await db.withExclusiveTransactionAsync(async tx => {
    if (await readVisibleGroup(tx, owner, group.id)) throw new Error('This account already has this group.');
    // Local revisions do not share the server's sequence space.
    const empty = { ...group, version: 0, activity: [], expenses: [], settlements: [], balances: Object.fromEntries(group.participants.map(p => [p.id, '0'])), transfers: [] };
    await saveGroup(tx, owner, empty, 'shared');
    for (const command of commands) await enqueue(tx, owner, command);
  });
}

// Existing installs have unowned phone data. Only an explicit claim can bind it
// to an account. Recovery snapshots are not another visible ledger or outbox.
const legacyKey = (id: string) => `legacy-recovery:${id}`;
export async function listLegacyGroups(db: Database): Promise<Group[]> {
  return (await listGroups(db, 'local')).map(row => row.group);
}

export async function readLegacySource(db: Database, id: string): Promise<LegacySource | null> {
  const cached = await readGroup(db, 'local', id);
  return cached ? { group: cached.group, draft: await readDraft(db, 'local', id), commands: (await pendingCommands(db, 'local')).filter(command => command.group_id === id) } : null;
}

export async function listLegacyRecoveries(db: Database, owner: string): Promise<LegacyRecovery[]> {
  const rows = await db.getAllAsync<{ body: string }>("SELECT body FROM drafts WHERE owner=? AND group_id LIKE 'legacy-recovery:%' ORDER BY group_id", owner);
  return rows.map(row => JSON.parse(row.body) as LegacyRecovery | null).filter((row): row is LegacyRecovery => row !== null);
}

export async function removeLegacyRecovery(db: Database, owner: string, id: string): Promise<void> {
  await db.runAsync('DELETE FROM drafts WHERE owner=? AND group_id=?', owner, legacyKey(id));
}

export async function readLegacyRecovery(db: Database, owner: string, id: string): Promise<LegacyRecovery | null> {
  return readDraft(db, owner, legacyKey(id));
}

export async function bindLegacyGroup(db: Database, owner: string, recovery: LegacyRecovery, canonical: Group | null, commands: Command[]): Promise<void> {
  if (!owner || owner === 'local') throw new Error('Sign in before recovering phone records.');
  await db.withExclusiveTransactionAsync(async tx => {
    const source = await readLegacySource(tx, recovery.group.id);
    if (!source || JSON.stringify(source) !== JSON.stringify({ group: recovery.group, draft: recovery.draft, commands: recovery.commands })) throw new Error('Phone records changed. Review them again before recovering.');
    if (await readLegacyRecovery(tx, owner, recovery.group.id)) throw new Error('This account already has a recovery snapshot for this group.');
    await saveDraft(tx, owner, legacyKey(recovery.group.id), recovery);
    if (recovery.status !== 'conflict' && recovery.draft != null && await readDraft(tx, owner, recovery.group.id) == null) {
      let draft = recovery.draft;
      if (typeof draft === 'object' && !Array.isArray(draft)) {
        const body = draft as Record<string, unknown>, editing = body.editing as { id?: string; version?: number } | null | undefined;
        const id = body.schemaVersion === 1 ? body.expenseId : editing?.id;
        const original = recovery.group.expenses.find(expense => expense.id === id);
        const version = canonical?.expenses.find(expense => expense.id === id)?.version ?? (recovery.status === 'queued' && original ? original.deleted ? 2 : 1 : undefined);
        // Only rebase the copied draft. Keep every proposed financial value and
        // the complete original draft in recovery for review/export.
        if (version) draft = body.schemaVersion === 1 ? { ...body, expenseVersion: version } : { ...body, editing: { ...editing, version } };
      }
      await saveDraft(tx, owner, recovery.group.id, draft);
    }
    if (canonical) await saveGroup(tx, owner, canonical, 'shared');
    for (const command of commands) await enqueue(tx, owner, command);
    await tx.runAsync('DELETE FROM outbox WHERE owner=? AND group_id=?', 'local', recovery.group.id);
    await tx.runAsync('DELETE FROM drafts WHERE owner=? AND group_id=?', 'local', recovery.group.id);
    await tx.runAsync('DELETE FROM groups_cache WHERE owner=? AND id=?', 'local', recovery.group.id);
  });
}

export async function wipeAccount(db: Database, owner: string): Promise<void> {
  await db.withExclusiveTransactionAsync(async tx => {
    await tx.runAsync('DELETE FROM outbox WHERE owner=?', owner);
    await tx.runAsync('DELETE FROM groups_cache WHERE owner=?', owner);
    await tx.runAsync('DELETE FROM group_summaries WHERE owner=?', owner);
    await tx.runAsync('DELETE FROM drafts WHERE owner=?', owner);
    await tx.runAsync('DELETE FROM sync_state WHERE owner=?', owner);
    await tx.runAsync('DELETE FROM expense_history WHERE owner=?', owner);
  });
}

// Only an unattempted bill can be edited in place. An uncertain write retains
// its immutable ID/body until its server result is reconciled.
export async function enqueueBill(db: Database, owner: string, command: Command): Promise<void> {
  await db.withExclusiveTransactionAsync(async tx => {
    const previous = (await pendingCommands(tx, owner)).find(row => row.group_id === command.group_id && row.body.id === command.body.id && /\/expenses(?:\/[^/]+)?$/.test(row.path));
    if (!previous) { await enqueue(tx, owner, command); return; }
    if (previous.attempted || previous.state !== 'pending') throw new Error('Reconnect and review this bill before editing an unconfirmed change. Its original saved change is kept.');
    const body: Record<string, unknown> = { ...command.body, command_id: previous.command_id };
    if (previous.method === 'POST') delete body.version;
    else body.version = previous.body.version;
    await tx.runAsync('UPDATE outbox SET body=? WHERE owner=? AND command_id=? AND attempted=0', JSON.stringify(body), owner, previous.command_id);
  });
}

export async function confirmedSync(db: Database, owner: string): Promise<string | null> {
  return (await db.getFirstAsync<{ confirmed_at: string }>('SELECT confirmed_at FROM sync_state WHERE owner=?', owner))?.confirmed_at ?? null;
}
export async function confirmSync(db: Database, owner: string, current: () => boolean = () => true): Promise<boolean> {
  let confirmed = false;
  await db.withExclusiveTransactionAsync(async tx => {
    if (!current() || (await pendingCommands(tx, owner)).length) return;
    const waiting = await tx.getFirstAsync<{ n: number }>("SELECT count(*) AS n FROM drafts WHERE owner=? AND group_id LIKE 'media-upload:%' AND body<>?", owner, 'null');
    if (waiting?.n) return;
    for (const row of await listGroups(tx, owner)) {
      const full = await tx.getFirstAsync<{ version: number }>("SELECT json_extract(snapshot,'$.version') AS version FROM groups_cache WHERE owner=? AND id=? AND kind='shared' AND json_extract(snapshot,'$.read_mode') IS NULL", owner, row.group.id);
      if (!full || full.version < row.group.version) return;
      const snapshot = await readGroup(tx, owner, row.group.id);
      for (const expense of snapshot!.group.expenses) {
        const history = await readExpenseHistory(tx, owner, row.group.id, expense.id, row.group.version);
        if (!history || history.next_before !== null) return;
      }
    }
    if (!current()) return;
    await tx.runAsync('INSERT INTO sync_state(owner,confirmed_at) VALUES(?,?) ON CONFLICT(owner) DO UPDATE SET confirmed_at=excluded.confirmed_at', owner, new Date().toISOString());
    if (!current()) throw new Error('The signed-in account changed.');
    confirmed = true;
  });
  return confirmed;
}

export async function readExpenseHistory(db: Database, owner: string, groupId: string, expenseId: string, version?: number): Promise<ExpenseHistoryPage | null> {
  const group = await db.getFirstAsync<{ kind: string; version: number }>(`SELECT kind,json_extract(snapshot,'$.version') AS version FROM (${visibleGroups} AND id=?)`, owner, owner, groupId);
  if (group?.kind !== 'shared' || version !== undefined && group.version !== version) return null;
  const row = await db.getFirstAsync<{ body: string }>('SELECT body FROM expense_history WHERE owner=? AND group_id=? AND expense_id=? AND version=?', owner, groupId, expenseId, group.version);
  return row ? JSON.parse(row.body) as ExpenseHistoryPage : null;
}

export async function saveExpenseHistory(db: Database, owner: string, groupId: string, expenseId: string, page: ExpenseHistoryPage, before?: number, current: () => boolean = () => true): Promise<ExpenseHistoryPage> {
  if (page.group_id !== groupId || page.expense_id !== expenseId || !Number.isSafeInteger(page.version) || page.version < 0 || !Array.isArray(page.items) || page.items.length > 50
    || page.next_before !== null && (!Number.isSafeInteger(page.next_before) || page.next_before < 1 || before !== undefined && page.next_before >= before)
    || page.items.some((item, index) => !item.id || !Number.isSafeInteger(item.sequence) || item.sequence < 1 || before !== undefined && item.sequence >= before || index > 0 && page.items[index - 1].sequence <= item.sequence || !Array.isArray(item.changes))
    || new Set(page.items.map(item => item.id)).size !== page.items.length) throw new Error('This history is unavailable.');
  let saved = page;
  await db.withExclusiveTransactionAsync(async tx => {
    const group = await tx.getFirstAsync<{ kind: string; version: number }>(`SELECT kind,json_extract(snapshot,'$.version') AS version FROM (${visibleGroups} AND id=?)`, owner, owner, groupId);
    if (!current() || group?.kind !== 'shared' || group.version !== page.version) throw new Error('History changed. Refresh to see the latest.');
    const old = await readExpenseHistory(tx, owner, groupId, expenseId, page.version);
    if (before !== undefined && (!old || old.next_before !== null && before < old.next_before)) throw new Error('History changed. Refresh to see the latest.');
    if (old) {
      const next = old.next_before === null || page.next_before === null ? null : Math.min(old.next_before, page.next_before);
      saved = { ...page, items: [...old.items.filter(item => !page.items.some(value => value.id === item.id)), ...page.items].sort((a, b) => b.sequence - a.sequence), next_before: next, legacy_gap: old.legacy_gap || page.legacy_gap };
    }
    await tx.runAsync('INSERT INTO expense_history(owner,group_id,expense_id,version,body) VALUES(?,?,?,?,?) ON CONFLICT(owner,group_id,expense_id) DO UPDATE SET version=excluded.version,body=excluded.body', owner, groupId, expenseId, page.version, JSON.stringify(saved));
    if (!current()) throw new Error('The signed-in account changed.');
  });
  return saved;
}

export async function forgetExpenseHistory(db: Database, owner: string, groupId: string, expenseId: string): Promise<void> {
  await db.withExclusiveTransactionAsync(async tx => {
    await tx.runAsync('DELETE FROM expense_history WHERE owner=? AND group_id=? AND expense_id=?', owner, groupId, expenseId);
    await tx.runAsync('DELETE FROM sync_state WHERE owner=?', owner);
  });
}
