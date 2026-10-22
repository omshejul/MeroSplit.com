import type { DatabaseSync } from 'node:sqlite';
import type { Database } from '../src/storage.ts';

export function sqliteAdapter(raw: DatabaseSync): Database {
  const db: Database = {
    async execAsync(sql) { raw.exec(sql); },
    async runAsync(sql, ...params) { return raw.prepare(sql).run(...params); },
    async getFirstAsync<T>(sql: string, ...params: (string | number | null)[]) { return (raw.prepare(sql).get(...params) ?? null) as T | null; },
    async getAllAsync<T>(sql: string, ...params: (string | number | null)[]) { return raw.prepare(sql).all(...params) as T[]; },
    async withExclusiveTransactionAsync(task) { raw.exec('BEGIN IMMEDIATE'); try { await task(db); raw.exec('COMMIT'); } catch (error) { raw.exec('ROLLBACK'); throw error; } },
  };
  return db;
}
