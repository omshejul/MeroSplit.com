import type { Database } from './storage.ts';

const retryDelays = [25, 50, 100, 200, 400];
const busyFailure = (cause: unknown) => new Error("MeroSplit couldn't finish that just now. Please try again in a moment.", { cause });
function isBusy(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as { code?: unknown; errcode?: unknown; message?: unknown };
  return typeof value.errcode === 'number' && (value.errcode & 255) === 5 || value.code === 5
    || typeof value.code === 'string' && /^SQLITE_BUSY(?:_|$)/.test(value.code)
    || typeof value.message === 'string' && /\bdatabase is locked\b|\bSQLITE_BUSY\b|\bError code 5\b/i.test(value.message);
}

// All calls share one queue. A transaction uses the same connection without
// queueing its own queries, so other callers cannot join or interrupt it.
export function serializedDatabase(connection: Omit<Database, 'withExclusiveTransactionAsync'>, recoverBusy = false): Database {
  let tail: Promise<unknown> = Promise.resolve();
  async function query<T>(work: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try { return await work(); }
      catch (error) {
        if (!recoverBusy || !isBusy(error)) throw error;
        if (attempt === retryDelays.length) throw busyFailure(error);
        await new Promise(done => setTimeout(done, retryDelays[attempt]));
      }
    }
  }
  async function batch(sql: string): Promise<void> {
    try { await connection.execAsync(sql); }
    catch (error) { if (recoverBusy && isBusy(error)) throw busyFailure(error); throw error; }
  }
  const queue = <T>(work: () => Promise<T>): Promise<T> => {
    const result = tail.catch(() => {}).then(work); tail = result; return result;
  };
  // Retry single statements and transaction boundaries only. A batch or callback
  // may have side effects, so never replay one after a partially completed save.
  const transaction: Database = {
    execAsync: batch,
    runAsync: (sql, ...params) => query(() => connection.runAsync(sql, ...params)),
    getFirstAsync: <T>(sql: string, ...params: (string | number | null)[]) => query(() => connection.getFirstAsync<T>(sql, ...params)),
    getAllAsync: <T>(sql: string, ...params: (string | number | null)[]) => query(() => connection.getAllAsync<T>(sql, ...params)),
    withExclusiveTransactionAsync: async () => { throw new Error('Nested cache transactions are unavailable.'); },
  };
  return {
    execAsync: sql => queue(() => batch(sql)),
    runAsync: (sql, ...params) => queue(() => query(() => connection.runAsync(sql, ...params))),
    getFirstAsync: <T>(sql: string, ...params: (string | number | null)[]) => queue(() => query(() => connection.getFirstAsync<T>(sql, ...params))),
    getAllAsync: <T>(sql: string, ...params: (string | number | null)[]) => queue(() => query(() => connection.getAllAsync<T>(sql, ...params))),
    withExclusiveTransactionAsync: task => queue(async () => {
      await query(() => connection.execAsync('BEGIN IMMEDIATE'));
      try { await task(transaction); await query(() => connection.execAsync('COMMIT')); }
      catch (error) { try { await connection.execAsync('ROLLBACK'); } catch { /* Preserve the original failure. */ } throw error; }
    }),
  };
}
