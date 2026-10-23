import type { CachedGroup, Command, Group, LegacyRecovery, LegacySource } from './types';

type Bind = string | number | null;
// Small seam for native SQLite and the real SQLite adapter used by Node tests.
export interface Database {
  execAsync(sql: string): Promise<void>;
  runAsync(sql: string, ...params: Bind[]): Promise<unknown>;
  getFirstAsync<T>(sql: string, ...params: Bind[]): Promise<T | null>;
  getAllAsync<T>(sql: string, ...params: Bind[]): Promise<T[]>;
  withExclusiveTransactionAsync(task: (transaction: Database) => Promise<void>): Promise<void>;
}

export async function migrate(db: Database): Promise<void> {
  const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  if ((row?.user_version ?? 0) > 4) throw new Error('This database needs a newer app.');
  if (row?.user_version === 4) return;
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
      PRAGMA user_version = 4;
    `);
    const columns = await tx.getAllAsync<{ name: string }>('PRAGMA table_info(outbox)');
    if (!columns.some(column => column.name === 'base_version')) await tx.execAsync('ALTER TABLE outbox ADD COLUMN base_version INTEGER;');
  });
}

export async function saveGroup(db: Database, owner: string, group: Group, kind: CachedGroup['kind']): Promise<void> {
  const table = group.read_mode === 'summary' ? 'group_summaries' : 'groups_cache';
  await db.runAsync(`INSERT INTO ${table}(owner,id,kind,snapshot) VALUES(?,?,?,?) ON CONFLICT(owner,id) DO UPDATE SET kind=excluded.kind,snapshot=excluded.snapshot WHERE json_extract(${table}.snapshot,'$.version') <= json_extract(excluded.snapshot,'$.version') AND (${table}.kind<>excluded.kind OR ${table}.snapshot<>excluded.snapshot)`, owner, group.id, kind, JSON.stringify(group));
  // A newer authoritative version invalidates all old history, including redacted text.
  if (group.read_mode === 'summary') await db.runAsync("DELETE FROM groups_cache WHERE owner=? AND id=? AND json_extract(snapshot,'$.version') < ?", owner, group.id, group.version);
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

// Only call after the index and every listed snapshot were fetched successfully.
// A failed refresh must not interpret a partial result as revoked access.
export async function reconcileGroupCache(db: Database, owner: string, authorized: Group[]): Promise<string[]> {
  const visible = new Set(authorized.map(group => group.id)), unavailable: string[] = [];
  if (visible.size !== authorized.length) throw new Error('The group refresh was incomplete. Try again.');
  await db.withExclusiveTransactionAsync(async tx => {
    for (const group of authorized) await saveGroup(tx, owner, group, 'shared');
    const queued = await pendingCommands(tx, owner);
    const cached = await tx.getAllAsync<{ id: string; kind: string; snapshot: string }>(visibleGroups, owner, owner);
    for (const row of cached) {
      if (visible.has(row.id)) continue;
      const commands = queued.filter(command => command.group_id === row.id), group = JSON.parse(row.snapshot) as Group;
      if (group.version === 0 && commands.some(command => command.method === 'POST' && command.path === '/groups' && command.body.id === row.id)) continue;
      const keep = commands.length || await readDraft(tx, owner, row.id) != null || await readLegacyRecovery(tx, owner, row.id);
      for (const table of ['groups_cache', 'group_summaries']) {
        if (keep) await tx.runAsync(`UPDATE ${table} SET kind='unavailable' WHERE owner=? AND id=?`, owner, row.id);
        else await tx.runAsync(`DELETE FROM ${table} WHERE owner=? AND id=?`, owner, row.id);
      }
      if (row.kind !== 'unavailable') unavailable.push(row.id);
    }
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
  const rows = await db.getAllAsync<Omit<Command, 'body'> & { body: string }>('SELECT command_id,group_id,method,path,body,state,error,base_version FROM outbox WHERE owner=? ORDER BY ordinal', owner);
  return rows.map(({ base_version, ...row }) => ({ ...row, body: JSON.parse(row.body) as Command['body'], ...(base_version == null ? {} : { base_version }) }));
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
  });
}
