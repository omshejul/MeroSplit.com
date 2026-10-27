import { serverReachable } from './connectivity';
import * as SQLite from 'expo-sqlite';
import * as SecureStore from 'expo-secure-store';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { migrate } from './storage';
import type { Database } from './storage';
import type { Session } from './types';
import { defaultColorFamily, isColorFamily, type ColorFamily } from './theme';

let database: Promise<Database> | undefined;
export function storageIsDurable(): boolean { return true; }
export function isOnline(): boolean { return serverReachable(); }
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
const COLOR_FAMILY_KEY = 'splitdumb.colorFamily';
export async function savedColorFamily(): Promise<ColorFamily> {
  const value = await SecureStore.getItemAsync(COLOR_FAMILY_KEY);
  return isColorFamily(value) ? value : defaultColorFamily;
}
export async function saveColorFamily(value: ColorFamily): Promise<void> {
  if (!isColorFamily(value)) throw new Error('Choose a color.');
  await SecureStore.setItemAsync(COLOR_FAMILY_KEY, value);
}

// Older releases allowed pausing sync. All account changes now sync automatically.
export async function retireSyncPause(): Promise<void> { await SecureStore.deleteItemAsync('splitdumb.syncPaused'); }

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
