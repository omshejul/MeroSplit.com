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

export type AppearancePreference = 'system' | 'light' | 'dark';
const APPEARANCE_KEY = 'splitdumb.appearance';
export async function savedAppearance(): Promise<AppearancePreference> {
  const value = await SecureStore.getItemAsync(APPEARANCE_KEY);
  return value === 'light' || value === 'dark' ? value : 'system';
}
export async function saveAppearance(value: AppearancePreference): Promise<void> {
  if (!['system', 'light', 'dark'].includes(value)) throw new Error('Choose System, Light or Dark.');
  await SecureStore.setItemAsync(APPEARANCE_KEY, value);
}

export async function savedSyncPaused(): Promise<boolean> { return (await SecureStore.getItemAsync('splitdumb.syncPaused')) === 'true'; }
export async function saveSyncPaused(value: boolean): Promise<void> { await SecureStore.setItemAsync('splitdumb.syncPaused', String(value)); }

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
