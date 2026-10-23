import { accountOwner, ApiError, request } from './api.ts';
import { readDraft, saveDraft } from './storage.ts';
import type { Database } from './storage.ts';
import type { Session } from './types.ts';

export type MediaMetadata = { id: string; name: string; content_type: string; size: number };
export type PickedMedia = { uri: string; name: string; type: string; size: number };
export type MediaList = { attachments: MediaMetadata[]; can_modify: boolean };
export type AvatarResult = { avatar: MediaMetadata | null; cleanup_pending?: boolean };
export type AttachmentResult = { attachment: MediaMetadata; version: number };
export type MediaRemoval = { removed: true; cleanup_pending: boolean; version?: number };
export type PendingMediaUpload = { id: string; path: string; file: PickedMedia };
const imageTypes = ['image/jpeg', 'image/png', 'image/webp'];
const extensions: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };
const mimeForExtension: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', pdf: 'application/pdf' };
const uploadDraftKey = (path: string) => `media-upload:${path}`;
const pendingFilename = /^merosplit-upload-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\.(?:jpg|png|webp|pdf|bin)$/i;
const previewFilename = /^merosplit-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\.(?:jpg|png|webp|pdf|bin)$/i;

export function validateMedia(file: PickedMedia, avatar = false): void {
  if (!(avatar ? imageTypes : [...imageTypes, 'application/pdf']).includes(file.type)) throw new Error(avatar ? 'Choose a JPEG, PNG or WebP photo.' : 'Choose a JPEG, PNG, WebP image or PDF.');
  const limit = (avatar ? 5 : 20) * 1_048_576;
  if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > limit) throw new Error(`Choose a file above zero and up to ${avatar ? 5 : 20} MB.`);
  if (!file.uri.startsWith('file://') && !file.uri.startsWith('content://')) throw new Error('Choose a file stored on this device.');
}

export async function pickMedia(photo: boolean, avatar = false): Promise<PickedMedia | null> {
  const { File } = await import('expo-file-system');
  let selected: { uri: string; name?: string | null; mimeType?: string | null; size?: number };
  if (photo) {
    const picker = await import('expo-image-picker');
    const result = await picker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsMultipleSelection: false, quality: 0.85,
      preferredAssetRepresentationMode: picker.UIImagePickerPreferredAssetRepresentationMode.Compatible });
    if (result.canceled) return null;
    const asset = result.assets[0]; selected = { uri: asset.uri, name: asset.fileName, mimeType: asset.mimeType, size: asset.fileSize };
  } else {
    const picker = await import('expo-document-picker');
    const result = await picker.getDocumentAsync({ type: ['application/pdf', ...imageTypes], multiple: false, copyToCacheDirectory: true });
    if (result.canceled) return null;
    selected = result.assets[0];
  }
  // The photo picker may return a JPEG cache copy while retaining a HEIC source name.
  const extension = selected.uri.split(/[?#]/)[0].split('.').pop()?.toLowerCase() ?? '';
  const type = mimeForExtension[extension] ?? selected.mimeType ?? '';
  const originalName = selected.name || (avatar ? 'Profile photo' : 'Bill attachment');
  const name = `${originalName.replace(/\.[^.]+$/, '')}.${extensions[type] ?? extension}`;
  const file = { uri: selected.uri, name, type, size: selected.size || 0 };
  try { file.size = new File(selected.uri).size || file.size; validateMedia(file, avatar); return file; }
  catch (error) { await clearPickedMedia(file); throw error; }
}

export async function clearPickedMedia(file: PickedMedia): Promise<void> {
  const { File, Paths } = await import('expo-file-system');
  try {
    const cached = new File(file.uri);
    if (cached.uri.startsWith(`${Paths.cache.uri.replace(/\/$/, '')}/`) && cached.exists) cached.delete();
  } catch { /* Only a temporary picker copy may be removed. */ }
}

export async function uploadMedia<T>(session: Session, path: string, file: PickedMedia, id: string, fetcher: typeof fetch = fetch,
  readBytes: (uri: string) => Promise<Uint8Array> = async uri => { const { File } = await import('expo-file-system'); return new File(uri).bytes(); }): Promise<T> {
  const body = new FormData(); body.append('id', id);
  body.append('file', { name: file.name, type: file.type, bytes: () => readBytes(file.uri) } as unknown as Blob);
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const response = await fetcher(`${session.baseUrl}/api/v1${path}`, { method: 'POST', headers: { 'X-Session-Token': session.token }, body, signal: controller.signal })
      .catch(() => { throw new Error('Could not confirm the upload. Refresh to check whether it finished, then try again.'); });
    if (!response.headers.get('content-type')?.includes('json')) throw new ApiError(response.ok ? 502 : response.status, 'Could not confirm the upload. Refresh to check whether it finished, then try again.');
    const data = await response.json();
    if (!response.ok) throw new ApiError(response.status, String(data.detail ?? data.error ?? 'Could not upload this file.'));
    return data as T;
  } finally { clearTimeout(timer); }
}

export async function stageMediaUpload(file: PickedMedia, id: string): Promise<PickedMedia> {
  const { File, Paths } = await import('expo-file-system');
  const staged = new File(Paths.document, `merosplit-upload-${id}.${extensions[file.type] ?? 'bin'}`);
  try { await new File(file.uri).copy(staged); return { ...file, uri: staged.uri }; }
  catch (cause) { try { if (staged.exists) staged.delete(); } catch { /* Remove any incomplete staging copy. */ } throw cause; }
}

export async function clearStagedMedia(file: PickedMedia): Promise<void> {
  try {
    const { File, Paths } = await import('expo-file-system'), staged = new File(file.uri);
    if (staged.parentDirectory.uri.replace(/\/$/, '') === Paths.document.uri.replace(/\/$/, '') && pendingFilename.test(staged.name) && staged.exists) staged.delete();
  } catch { /* Account deletion can retry cleanup of this app-owned staged file. */ }
}

// Call before wiping the deleting account's drafts. Sign-out must retain these
// bytes so that a later sign-in can retry the same immutable upload.
export async function clearAccountMediaUploads(db: Database, session: Session, cleanup: (file: PickedMedia) => Promise<void> = clearStagedMedia): Promise<void> {
  const rows = await db.getAllAsync<{ body: string }>("SELECT body FROM drafts WHERE owner=? AND group_id LIKE 'media-upload:%'", accountOwner(session));
  for (const row of rows) {
    try {
      const upload = JSON.parse(row.body) as PendingMediaUpload | null;
      if (upload?.file?.uri && pendingFilename.test(upload.file.uri.split('/').at(-1) ?? '')) await cleanup(upload.file);
    } catch { /* One failed file cleanup must not affect another account's data. */ }
  }
}

export function pendingMediaUpload(db: Database, session: Session, path: string): Promise<PendingMediaUpload | null> {
  return readDraft<PendingMediaUpload>(db, accountOwner(session), uploadDraftKey(path));
}

export async function saveMediaUpload(db: Database, session: Session, upload: PendingMediaUpload): Promise<void> {
  const snapshot = JSON.parse(JSON.stringify(upload)) as PendingMediaUpload;
  await db.withExclusiveTransactionAsync(async tx => {
    const existing = await pendingMediaUpload(tx, session, snapshot.path);
    if (existing && JSON.stringify(existing) !== JSON.stringify(snapshot)) throw new Error('Finish the saved upload before choosing another file.');
    await saveDraft(tx, accountOwner(session), uploadDraftKey(snapshot.path), snapshot);
  });
}

export async function retryMediaUpload(db: Database, session: Session, path: string, send: typeof request = request, post: typeof uploadMedia = uploadMedia, cleanup: (file: PickedMedia) => Promise<void> = clearStagedMedia): Promise<MediaMetadata> {
  const pending = await pendingMediaUpload(db, session, path);
  if (!pending || pending.path !== path) throw new Error('There is no saved upload for this bill.');
  const clear = async () => {
    await db.runAsync('DELETE FROM drafts WHERE owner=? AND group_id=? AND body=?', accountOwner(session), uploadDraftKey(path), JSON.stringify(pending));
    await cleanup(pending.file);
  };
  // A previous POST may already have succeeded. Never mint another upload ID.
  let accepted = (await send<MediaList>(session, path)).attachments.find(item => item.id === pending.id);
  if (!accepted) {
    try { accepted = (await post<AttachmentResult>(session, path, pending.file, pending.id)).attachment; }
    catch (cause) {
      if (cause instanceof ApiError && [400, 413, 415, 422].includes(cause.status)) { await clear(); throw cause; }
      try { accepted = (await send<MediaList>(session, path)).attachments.find(item => item.id === pending.id); }
      catch { /* Preserve both request and staged bytes while the outcome is unknown. */ }
      if (!accepted) throw cause;
    }
  }
  if (accepted.id !== pending.id) throw new Error('Could not confirm this upload. Retry the saved file.');
  await clear();
  return accepted;
}

export async function freshMediaUrl(session: Session, id: string, send: typeof request = request): Promise<string> {
  const result = await send<{ url: string; expires_at: string }>(session, `/media/${encodeURIComponent(id)}/url`);
  if (!result.url.startsWith('https://') || !Number.isFinite(Date.parse(result.expires_at)) || Date.parse(result.expires_at) <= Date.now()) throw new Error('The file link is unavailable. Refresh and try again.');
  return result.url;
}

// Read links are requested at the moment of use. One refresh covers expiry while
// downloading without retaining a bearer URL in SQLite or retrying indefinitely.
export async function readPrivateMedia<T>(session: Session, id: string, read: (url: string) => Promise<T>, send: typeof request = request): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const url = await freshMediaUrl(session, id, send);
    try { return await read(url); }
    catch { if (attempt === 1) throw new Error('Could not open the file. Check your connection and try again.'); }
  }
  throw new Error('Could not open the file.');
}

export async function openPrivateMedia(session: Session, media: MediaMetadata): Promise<void> {
  const { File, Paths } = await import('expo-file-system');
  const file = new File(Paths.cache, `merosplit-${media.id}.${extensions[media.content_type] ?? 'bin'}`);
  try {
    await readPrivateMedia(session, media.id, async url => {
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 60_000);
      try { await File.downloadFileAsync(url, file, { idempotent: true, signal: controller.signal }); }
      finally { clearTimeout(timer); }
    });
    if (!await file.canPreview({ mimeType: media.content_type })) throw new Error('Install an app that can open this file, then try again.');
    await file.preview({ title: media.name, mimeType: media.content_type });
    // Native preview resolves at presentation, so keep this cache copy until the
    // next open or OS cache cleanup instead of deleting it under the viewer.
  } catch (error) {
    try { if (file.exists) file.delete(); } catch { /* Best-effort partial-download cleanup. */ }
    throw error;
  }
}

export async function clearMediaPreview(media: MediaMetadata): Promise<void> {
  const { File, Paths } = await import('expo-file-system');
  try { const file = new File(Paths.cache, `merosplit-${media.id}.${extensions[media.content_type] ?? 'bin'}`); if (file.exists) file.delete(); }
  catch { /* An already removed preview does not affect the accepted server deletion. */ }
}

export async function clearMediaPreviews(cacheFiles: () => Promise<{ name: string; delete(): void }[]> = async () => {
  const { Directory, File, Paths } = await import('expo-file-system');
  return new Directory(Paths.cache).list().filter(file => file instanceof File);
}): Promise<void> {
  try {
    for (const file of await cacheFiles()) if (previewFilename.test(file.name)) {
      try { file.delete(); } catch { /* Continue cleaning after a single-file failure. */ }
    }
  } catch { /* Preview cleanup must not prevent account sign-out or deletion. */ }
}

export function mediaSize(bytes: number): string { return bytes < 1_048_576 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1_048_576).toFixed(1)} MB`; }
