import { freshMediaUrl } from './media';
import type { ProfilePhoto, Session } from './types';
const cacheName = 'merosplit-profile-photos-v1';
const urls = new Map<string, Promise<string>>();
let generation = 0;
const ready = new Map<string, string>();
const photoKey = (session: Session, photo: ProfilePhoto) => `${session.baseUrl}/api/v1/profile-photo-cache?owner=${encodeURIComponent(session.userId)}&photo=${encodeURIComponent('id' in photo ? photo.id : photo.url)}`;
export const peekProfilePhoto = (session: Session, photo: ProfilePhoto) => ready.get(photoKey(session, photo));
export async function cachedProfilePhoto(session: Session, photo: ProfilePhoto): Promise<string> {
  const key = photoKey(session, photo);
  const previous = urls.get(key); if (previous) return previous;
  const current = generation;
  const load = (async () => {
    const cache = typeof caches !== 'undefined' ? await caches.open(cacheName).catch(() => null) : null;
    let response = await cache?.match(key).catch(() => undefined);
    if (!response) {
      const url = 'url' in photo ? photo.url : await freshMediaUrl(session, photo.id);
      response = await fetch(url, { credentials: 'omit' });
      if (!response.ok) throw new Error('Photo unavailable');
      if (current !== generation) throw new Error('Account changed');
      await cache?.put(key, response.clone()).catch(() => {});
    }
    const blob = await response.blob();
    if (current !== generation) throw new Error('Account changed');
    const uri = URL.createObjectURL(blob); ready.set(key, uri); return uri;
  })();
  urls.set(key, load);
  try { return await load; } catch (error) { if (urls.get(key) === load) urls.delete(key); throw error; }
}
export async function clearProfilePhotoCache(): Promise<void> {
  generation++;
  const previous = [...urls.values()]; urls.clear(); ready.clear();
  for (const pending of previous) void pending.then(url => URL.revokeObjectURL(url)).catch(() => {});
  if (typeof caches !== 'undefined') await caches.delete(cacheName);
}

export async function invalidateProfilePhoto(session: Session, photo: ProfilePhoto) {
  const key = photoKey(session, photo), uri = ready.get(key);
  ready.delete(key); urls.delete(key);
  if (uri) URL.revokeObjectURL(uri);
  if (typeof caches !== 'undefined') {
    const cache = await caches.open(cacheName).catch(() => null);
    await cache?.delete(key).catch(() => false);
  }
}
