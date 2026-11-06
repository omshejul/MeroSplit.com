import { freshMediaUrl } from './media.ts';
import type { ProfilePhoto, Session } from './types';

const pending = new Map<string, Promise<string>>();
let generation = 0;
const ready = new Map<string, string>();
const photoKey = (session: Session, photo: ProfilePhoto) => `${session.baseUrl}|${session.userId}|${'id' in photo ? photo.id : photo.url}`;
export const peekProfilePhoto = (session: Session, photo: ProfilePhoto) => ready.get(photoKey(session, photo));
export function clearProfilePhotoCache(): void { generation++; pending.clear(); ready.clear(); }

export async function cachedProfilePhoto(session: Session, photo: ProfilePhoto): Promise<string> {
  const current = generation;
  const { File, Paths } = require('expo-file-system') as typeof import('expo-file-system');
  const { digestStringAsync, CryptoDigestAlgorithm } = require('expo-crypto') as typeof import('expo-crypto');
  const key = await digestStringAsync(CryptoDigestAlgorithm.SHA256, photoKey(session, photo));
  if (current !== generation) throw new Error('Account changed');
  const file = new File(Paths.cache, `merosplit-avatar-${key}.img`);
  if (file.exists && file.size > 0) { ready.set(photoKey(session, photo), file.uri); return file.uri; }
  const previous = pending.get(key); if (previous) return previous;
  // Each generation owns its download file. A late completion cannot overwrite
  // or delete a newer sign-in's cached photo, even for the same account.
  const download = new File(Paths.cache, `merosplit-avatar-${key}-${current}.img`);
  const load = (async () => {
    try {
      const url = 'url' in photo ? photo.url : await freshMediaUrl(session, photo.id);
      if (current !== generation) throw new Error('Account changed');
      await File.downloadFileAsync(url, download, { idempotent: true });
      if (current !== generation) throw new Error('Account changed');
      download.move(file);
      ready.set(photoKey(session, photo), file.uri);
      return file.uri;
    } catch (error) {
      try { if (download.exists) download.delete(); } catch { /* Best-effort partial-download cleanup. */ }
      throw error;
    }
  })();
  pending.set(key, load);
  try { return await load; } finally { if (pending.get(key) === load) pending.delete(key); }
}

export async function invalidateProfilePhoto(session: Session, photo: ProfilePhoto) {
  const current = generation;
  ready.delete(photoKey(session, photo));
  const { File, Paths } = require('expo-file-system') as typeof import('expo-file-system');
  const { digestStringAsync, CryptoDigestAlgorithm } = require('expo-crypto') as typeof import('expo-crypto');
  const key = await digestStringAsync(CryptoDigestAlgorithm.SHA256, photoKey(session, photo));
  if (current !== generation) return;
  const file = new File(Paths.cache, `merosplit-avatar-${key}.img`);
  if (file.exists) file.delete();
}
