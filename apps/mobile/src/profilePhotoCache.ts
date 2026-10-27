import { File, Paths } from 'expo-file-system';
import { digestStringAsync, CryptoDigestAlgorithm } from 'expo-crypto';
import { freshMediaUrl } from './media';
import type { ProfilePhoto, Session } from './types';

const pending = new Map<string, Promise<string>>();
export async function cachedProfilePhoto(session: Session, photo: ProfilePhoto): Promise<string> {
  const key = await digestStringAsync(CryptoDigestAlgorithm.SHA256, `${session.baseUrl}|${session.userId}|${'id' in photo ? photo.id : photo.url}`);
  const file = new File(Paths.cache, `merosplit-avatar-${key}.img`);
  if (file.exists && file.size > 0) return file.uri;
  const previous = pending.get(key); if (previous) return previous;
  const load = (async () => {
    const url = 'url' in photo ? photo.url : await freshMediaUrl(session, photo.id);
    try { return (await File.downloadFileAsync(url, file, { idempotent: true })).uri; }
    catch (error) { if (file.exists) file.delete(); throw error; }
  })();
  pending.set(key, load);
  try { return await load; } finally { pending.delete(key); }
}
