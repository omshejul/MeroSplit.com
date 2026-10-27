import { freshMediaUrl } from './media.ts';
import type { ProfilePhoto, Session } from './types';

const pending = new Map<string, Promise<string>>();
let generation = 0;
export function clearProfilePhotoCache(): void { generation++; pending.clear(); }

export async function cachedProfilePhoto(session: Session, photo: ProfilePhoto): Promise<string> {
  const current = generation;
  const [{ File, Paths }, { digestStringAsync, CryptoDigestAlgorithm }] = await Promise.all([import('expo-file-system'), import('expo-crypto')]);
  const key = await digestStringAsync(CryptoDigestAlgorithm.SHA256, `${session.baseUrl}|${session.userId}|${'id' in photo ? photo.id : photo.url}`);
  if (current !== generation) throw new Error('Account changed');
  const file = new File(Paths.cache, `merosplit-avatar-${key}.img`);
  if (file.exists && file.size > 0) return file.uri;
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
      return file.uri;
    } catch (error) {
      try { if (download.exists) download.delete(); } catch { /* Best-effort partial-download cleanup. */ }
      throw error;
    }
  })();
  pending.set(key, load);
  try { return await load; } finally { if (pending.get(key) === load) pending.delete(key); }
}
