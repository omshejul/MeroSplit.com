import { freshMediaUrl } from './media';
import type { ProfilePhoto, Session } from './types';
const cacheName = 'merosplit-profile-photos-v1';
const urls = new Map<string, Promise<string>>();
let generation = 0;
export async function cachedProfilePhoto(session: Session, photo: ProfilePhoto): Promise<string> {
  const key = `${session.baseUrl}/api/v1/profile-photo-cache?owner=${encodeURIComponent(session.userId)}&photo=${encodeURIComponent('id' in photo ? photo.id : photo.url)}`;
  const previous = urls.get(key); if (previous) return previous;
  const current = generation;
  const load = (async () => {
    const cache = typeof caches !== 'undefined' ? await caches.open(cacheName) : null;
    let response = await cache?.match(key);
    if (!response) {
      const url = 'url' in photo ? photo.url : await freshMediaUrl(session, photo.id);
      response = await fetch(url, { credentials: 'omit' });
      if (!response.ok) throw new Error('Photo unavailable');
      if (current !== generation) throw new Error('Account changed');
      await cache?.put(key, response.clone());
    }
    const blob = await response.blob();
    if (current !== generation) throw new Error('Account changed');
    return URL.createObjectURL(blob);
  })();
  urls.set(key, load);
  try { return await load; } catch (error) { urls.delete(key); throw error; }
}
export async function clearProfilePhotoCache(): Promise<void> {
  generation++;
  const previous = [...urls.values()]; urls.clear();
  for (const pending of previous) void pending.then(url => URL.revokeObjectURL(url)).catch(() => {});
  if (typeof caches !== 'undefined') await caches.delete(cacheName);
}
