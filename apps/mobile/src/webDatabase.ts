import type { Database } from './storage.ts';

// All calls share one queue. A transaction receives the raw connection so other
// callers cannot accidentally join it while awaiting a callback's next query.
export function serializedDatabase(connection: Omit<Database, 'withExclusiveTransactionAsync'>): Database {
  let tail: Promise<unknown> = Promise.resolve();
  const queue = <T>(work: () => Promise<T>): Promise<T> => {
    const result = tail.catch(() => {}).then(work); tail = result; return result;
  };
  const transaction: Database = {
    execAsync: sql => connection.execAsync(sql),
    runAsync: (sql, ...params) => connection.runAsync(sql, ...params),
    getFirstAsync: <T>(sql: string, ...params: (string | number | null)[]) => connection.getFirstAsync<T>(sql, ...params),
    getAllAsync: <T>(sql: string, ...params: (string | number | null)[]) => connection.getAllAsync<T>(sql, ...params),
    withExclusiveTransactionAsync: async () => { throw new Error('Nested cache transactions are unavailable.'); },
  };
  return {
    execAsync: sql => queue(() => connection.execAsync(sql)),
    runAsync: (sql, ...params) => queue(() => connection.runAsync(sql, ...params)),
    getFirstAsync: <T>(sql: string, ...params: (string | number | null)[]) => queue(() => connection.getFirstAsync<T>(sql, ...params)),
    getAllAsync: <T>(sql: string, ...params: (string | number | null)[]) => queue(() => connection.getAllAsync<T>(sql, ...params)),
    withExclusiveTransactionAsync: task => queue(async () => {
      await connection.execAsync('BEGIN IMMEDIATE');
      try { await task(transaction); await connection.execAsync('COMMIT'); }
      catch (error) { try { await connection.execAsync('ROLLBACK'); } catch { /* Preserve the original failure. */ } throw error; }
    }),
  };
}
