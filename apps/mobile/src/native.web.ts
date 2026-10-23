import * as SQLite from 'expo-sqlite';
import { migrate } from './storage';
import { serializedDatabase } from './webDatabase';
import { openBrowserStorage } from './browserStorage';
import type { Database } from './storage';
import type { Session } from './types';

let database: Promise<Database> | undefined;
let durable = true;
export function storageIsDurable(): boolean { return durable; }
export function isOnline(): boolean { return navigator.onLine; }
export function getDatabase(): Promise<Database> {
  database ??= (async () => {
    if (!window.crossOriginIsolated || typeof SharedArrayBuffer === 'undefined') throw new Error('This browser cannot open MeroSplit storage. Use a current Safari, Chrome, Edge or Firefox browser.');
    try {
      const result = await openBrowserStorage(
        async () => {
          if (!navigator.storage?.getDirectory) throw new Error('Persistent storage unavailable');
          return serializedDatabase(await SQLite.openDatabaseAsync('merosplit-web.db'));
        },
        async () => {
          SQLite.configureWeb({ memoryOnly: true });
          return serializedDatabase(await SQLite.openDatabaseAsync(':memory:', { useNewConnection: true }));
        }, migrate,
      );
      durable = result.durable; return result.db;
    } catch { database = undefined; throw new Error('Could not open browser storage. Use a regular browser window, allow site storage, and close other MeroSplit tabs before retrying. Keep site data to preserve pending changes.'); }
  })();
  return database;
}
const SESSION_KEY = 'merosplit.web.session', APPEARANCE_KEY = 'merosplit.web.appearance';
function readPreference(key: string): string | null { try { return localStorage.getItem(key); } catch { return null; } }
function writePreference(key: string, value: string | null): void { try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch { /* HttpOnly account cookies remain authoritative when metadata storage is blocked. */ } }
export async function savedSession(): Promise<Session | null> {
  const raw = readPreference(SESSION_KEY);
  try {
    const value = raw ? JSON.parse(raw) as Session : null;
    if (value?.baseUrl === window.location.origin && value.userId && value.email) return { ...value, token: `browser-session:${value.userId}` };
  } catch { /* Recover the existing HttpOnly session if browser metadata was cleared. */ }
  try {
    const response = await fetch('/api/v1/me', { credentials: 'same-origin', signal: AbortSignal.timeout(5000) });
    if (!response.ok) return null;
    const user = await response.json() as { id?: string | number; email?: string };
    if (!user.id || !user.email) return null;
    const session = { baseUrl: window.location.origin, userId: String(user.id), email: user.email, token: `browser-session:${user.id}` };
    await saveSession(session); return session;
  } catch { return null; }
}
export async function saveSession(session: Session | null): Promise<void> {
  writePreference(SESSION_KEY, session ? JSON.stringify({ ...session, token: `browser-session:${session.userId}` }) : null);
}
export type AppearancePreference = 'system' | 'light' | 'dark';
export async function savedAppearance(): Promise<AppearancePreference> { const value = readPreference(APPEARANCE_KEY); return value === 'light' || value === 'dark' ? value : 'system'; }
export async function saveAppearance(value: AppearancePreference): Promise<void> { writePreference(APPEARANCE_KEY, value); }
export async function retireSyncPause(): Promise<void> { writePreference('splitdumb.syncPaused', null); }
export async function shareJson(filename: string, data: unknown): Promise<void> { return shareText(`${filename}.json`, JSON.stringify(data, null, 2), 'application/json'); }
export async function shareText(filename: string, data: string, mimeType: string): Promise<void> {
  const url = URL.createObjectURL(new Blob([data], { type: mimeType })), link = document.createElement('a');
  try { link.href = url; link.download = filename; document.body.appendChild(link); link.click(); }
  finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
}
