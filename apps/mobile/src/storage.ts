import type { CachedGroup, Command, Group } from './types';

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
  if ((row?.user_version ?? 0) > 2) throw new Error('This database needs a newer app.');
  if (row?.user_version === 2) return;
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
      PRAGMA user_version = 2;
    `);
  });
}

export async function saveGroup(db: Database, owner: string, group: Group, kind: CachedGroup['kind']): Promise<void> {
  await db.runAsync('INSERT INTO groups_cache(owner,id,kind,snapshot) VALUES(?,?,?,?) ON CONFLICT(owner,id) DO UPDATE SET kind=excluded.kind,snapshot=excluded.snapshot WHERE json_extract(groups_cache.snapshot,\'$.version\') <= json_extract(excluded.snapshot,\'$.version\')', owner, group.id, kind, JSON.stringify(group));
}

export async function saveDraft(db: Database, owner: string, groupId: string, draft: unknown): Promise<void> {
  await db.runAsync('INSERT INTO drafts(owner,group_id,body) VALUES(?,?,?) ON CONFLICT(owner,group_id) DO UPDATE SET body=excluded.body', owner, groupId, JSON.stringify(draft));
}

export async function readDraft<T>(db: Database, owner: string, groupId: string): Promise<T | null> {
  const row = await db.getFirstAsync<{ body: string }>('SELECT body FROM drafts WHERE owner=? AND group_id=?', owner, groupId);
  return row ? JSON.parse(row.body) as T : null;
}

export async function listGroups(db: Database, owner: string): Promise<CachedGroup[]> {
  const rows = await db.getAllAsync<{ kind: CachedGroup['kind']; snapshot: string }>('SELECT kind,snapshot FROM groups_cache WHERE owner=? ORDER BY id', owner);
  return rows.map(row => ({ kind: row.kind, group: JSON.parse(row.snapshot) as Group }));
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
  await db.runAsync('INSERT INTO outbox(owner,command_id,group_id,method,path,body,state,error) VALUES(?,?,?,?,?,?,?,?)', owner, command.command_id, command.group_id, command.method, command.path, body, command.state, command.error);
}

export async function pendingCommands(db: Database, owner: string): Promise<Command[]> {
  const rows = await db.getAllAsync<Omit<Command, 'body'> & { body: string }>('SELECT command_id,group_id,method,path,body,state,error FROM outbox WHERE owner=? ORDER BY ordinal', owner);
  return rows.map(row => ({ ...row, body: JSON.parse(row.body) as Command['body'] }));
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

export async function publishLocal(db: Database, owner: string, group: Group, commands: Command[]): Promise<void> {
  await db.withExclusiveTransactionAsync(async tx => {
    if (await readGroup(tx, owner, group.id)) throw new Error('This account already has this group.');
    // Local revisions do not share the server's sequence space.
    const empty = { ...group, version: 0, activity: [], expenses: [], settlements: [], balances: Object.fromEntries(group.participants.map(p => [p.id, '0'])), transfers: [] };
    await saveGroup(tx, owner, empty, 'shared');
    for (const command of commands) await enqueue(tx, owner, command);
  });
}

export async function wipeAccount(db: Database, owner: string): Promise<void> {
  await db.withExclusiveTransactionAsync(async tx => {
    await tx.runAsync('DELETE FROM outbox WHERE owner=?', owner);
    await tx.runAsync('DELETE FROM groups_cache WHERE owner=?', owner);
    await tx.runAsync('DELETE FROM drafts WHERE owner=?', owner);
  });
}
