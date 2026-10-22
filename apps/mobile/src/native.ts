import * as SQLite from 'expo-sqlite';
import * as SecureStore from 'expo-secure-store';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { migrate } from './storage';
import type { Database } from './storage';
import type { Session } from './types';

let database: Promise<Database> | undefined;
export function getDatabase(): Promise<Database> {
  database ??= (async () => {
    const db = await SQLite.openDatabaseAsync('splitdumb.db');
    await db.execAsync('PRAGMA journal_mode=WAL;');
    await migrate(db);
    return db;
  })();
  return database;
}

const SESSION_KEY = 'splitdumb.session';
export async function savedSession(): Promise<Session | null> {
  const value = await SecureStore.getItemAsync(SESSION_KEY);
  return value ? JSON.parse(value) as Session : null;
}
export async function saveSession(session: Session | null): Promise<void> {
  if (session) await SecureStore.setItemAsync(SESSION_KEY, JSON.stringify(session));
  else await SecureStore.deleteItemAsync(SESSION_KEY);
}

export async function shareJson(filename: string, data: unknown): Promise<void> {
  return shareText(`${filename}.json`, JSON.stringify(data, null, 2), 'application/json');
}

export async function shareText(filename: string, data: string, mimeType: string): Promise<void> {
  if (!await Sharing.isAvailableAsync()) throw new Error('File sharing is unavailable on this device.');
  const file = new File(Paths.cache, filename);
  try {
    file.create({ overwrite: true });
    file.write(data);
    await Sharing.shareAsync(file.uri, { mimeType, UTI: mimeType === 'application/json' ? 'public.json' : 'public.comma-separated-values-text' });
  } finally { if (file.exists) file.delete(); }
}

export async function localSelfTest(): Promise<string> {
  const db = await SQLite.openDatabaseAsync('splitdumb-selftest.db');
  try {
    await migrate(db);
    await db.runAsync('DELETE FROM outbox WHERE owner=?', 'selftest');
    await db.runAsync('INSERT INTO outbox(owner,command_id,group_id,method,path,body,state,error) VALUES(?,?,?,?,?,?,?,?)', 'selftest', 'restart-probe', 'test-group', 'POST', '/test', '{}', 'pending', null);
  } finally { await db.closeAsync(); }
  const reopened = await SQLite.openDatabaseAsync('splitdumb-selftest.db');
  try {
    const row = await reopened.getFirstAsync<{ count: number }>('SELECT COUNT(*) AS count FROM outbox WHERE owner=? AND command_id=?', 'selftest', 'restart-probe');
    if (row?.count !== 1) throw new Error('SQLite restart test failed.');
    await reopened.runAsync('DELETE FROM outbox WHERE owner=?', 'selftest');
    return 'SQLite migration, write, close, reopen and read passed.';
  } finally { await reopened.closeAsync(); }
}
