import type { Database } from './storage.ts';

// The fallback is explicit and uses the same SQLite/transaction implementation.
// The caller must prevent offline writes and label this cache as temporary.
export async function openBrowserStorage(
  openPersistent: () => Promise<Database>,
  openMemory: () => Promise<Database>,
  migrate: (db: Database) => Promise<void>,
): Promise<{ db: Database; durable: boolean }> {
  let db: Database;
  try { db = await openPersistent(); }
  catch { db = await openMemory(); await migrate(db); return { db, durable: false }; }
  // A migration failure must never hide potentially recoverable durable data.
  await migrate(db); return { db, durable: true };
}
