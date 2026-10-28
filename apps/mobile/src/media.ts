import { readPrefetch, readScope } from './prefetch.ts';
import { accountOwner, ApiError, request } from './api.ts';
import { readDraft, saveDraft, enqueue, discardCommand } from './storage.ts';
import type { Database } from './storage.ts';
import type { Session, Command } from './types.ts';
import { clearStagedMedia, mediaFilePart, readMediaBytes } from './mediaPlatform.ts';
import { sessionRequest } from './transport.ts';
export { validateMedia, pickMedia, clearPickedMedia, stageMediaUpload, clearStagedMedia, openPrivateMedia, clearMediaPreview, clearMediaPreviews } from './mediaPlatform.ts';

export type MediaMetadata = { id: string; name: string; content_type: string; size: number };
export type PickedMedia = { uri: string; name: string; type: string; size: number };
export type MediaList = { attachments: MediaMetadata[]; can_modify: boolean };
export type AvatarResult = { avatar: MediaMetadata | null; profile_photo?: import("./types").ProfilePhoto | null; cleanup_pending?: boolean };
export type AttachmentResult = { attachment: MediaMetadata; version: number };
export type MediaRemoval = { removed: true; cleanup_pending: boolean; version?: number };
export type PendingMediaUpload = { id: string; path: string; file: PickedMedia };
const uploadDraftKey = (path: string) => `media-upload:${path}`;
const pendingFilename = /^merosplit-upload-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\.(?:jpg|png|webp|pdf|bin)$/i;




export async function uploadMedia<T>(session: Session, path: string, file: PickedMedia, id: string, fetcher: typeof fetch = fetch,
  readBytes: (uri: string) => Promise<Uint8Array> = readMediaBytes, current: () => boolean = () => true): Promise<T> {
  if (path === '/me/avatar') readPrefetch.invalidate(readScope(session));
  const body = new FormData(); body.append('id', id);
  body.append('file', await mediaFilePart(file, readBytes));
  if (!current()) throw new Error('The signed-in account changed.');
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const response = await sessionRequest(session, `/api/v1${path}`, { method: 'POST', body, signal: controller.signal }, fetcher)
      .catch(() => { throw new Error('Could not confirm the upload. Refresh to check whether it finished, then try again.'); });
    if (!response.headers.get('content-type')?.includes('json')) throw new ApiError(response.ok ? 502 : response.status, 'Could not confirm the upload. Refresh to check whether it finished, then try again.');
    const data = await response.json();
    if (!response.ok) throw new ApiError(response.status, String(data.detail ?? data.error ?? 'Could not upload this file.'));
    return data as T;
  } finally { clearTimeout(timer); if (path === '/me/avatar') readPrefetch.invalidate(readScope(session)); }
}



// Call before wiping the deleting account's drafts. Sign-out must retain these
// bytes so that a later sign-in can retry the same immutable upload.
export async function clearAccountMediaUploads(db: Database, session: Session, cleanup: (file: PickedMedia) => Promise<void> = clearStagedMedia): Promise<void> {
  const rows = await db.getAllAsync<{ body: string }>("SELECT body FROM drafts WHERE owner=?", accountOwner(session));
  for (const row of rows) {
    try {
      const saved = JSON.parse(row.body);
      const upload = saved?.attachment ?? saved as PendingMediaUpload | null;
      if (upload?.file?.uri && pendingFilename.test(upload.file.uri.split('/').at(-1) ?? '')) await cleanup(upload.file);
    } catch { /* One failed file cleanup must not affect another account's data. */ }
  }
}

export function pendingMediaUpload(db: Database, session: Session, path: string): Promise<PendingMediaUpload | null> {
  return readDraft<PendingMediaUpload>(db, accountOwner(session), uploadDraftKey(path));
}

async function writeMediaUpload(tx: Database, session: Session, snapshot: PendingMediaUpload): Promise<void> {
  const existing = await pendingMediaUpload(tx, session, snapshot.path);
  if (existing && JSON.stringify(existing) !== JSON.stringify(snapshot)) throw new Error('Finish the saved upload before choosing another file.');
  await saveDraft(tx, accountOwner(session), uploadDraftKey(snapshot.path), snapshot);
}

export async function saveMediaUpload(db: Database, session: Session, upload: PendingMediaUpload): Promise<void> {
  const snapshot = JSON.parse(JSON.stringify(upload)) as PendingMediaUpload;
  await db.withExclusiveTransactionAsync(tx => writeMediaUpload(tx, session, snapshot));
}

export async function enqueueExpenseWithMedia(db: Database, session: Session, command: Command, upload: PendingMediaUpload, replacing?: string): Promise<void> {
  const snapshot = JSON.parse(JSON.stringify(upload)) as PendingMediaUpload;
  if (command.method !== 'POST' || command.path !== `/groups/${command.group_id}/expenses` || snapshot.path !== `${command.path}/${command.body.id}/attachments`) throw new Error('This saved file belongs to a different bill.');
  await db.withExclusiveTransactionAsync(async tx => {
    await writeMediaUpload(tx, session, snapshot);
    if (replacing) await discardCommand(tx, accountOwner(session), replacing);
    await enqueue(tx, accountOwner(session), command);
    await saveDraft(tx, accountOwner(session), command.group_id, null);
  });
}

export async function removePendingMediaUpload(db: Database, session: Session, path: string, send: typeof request = request, cleanup = clearStagedMedia): Promise<void> {
  const pending = await pendingMediaUpload(db, session, path);
  if (!pending) return;
  // Resolve an uncertain POST before removing its local retry. If it arrived,
  // the explicit remove action also removes that exact accepted attachment.
  const accepted = (await send<MediaList>(session, path)).attachments.find(item => item.id === pending.id);
  if (accepted) await send(session, `${path}/${encodeURIComponent(pending.id)}`, 'DELETE');
  await db.runAsync('DELETE FROM drafts WHERE owner=? AND group_id=? AND body=?', accountOwner(session), uploadDraftKey(path), JSON.stringify(pending));
  await cleanup(pending.file);
}

export async function retryMediaUpload(db: Database, session: Session, path: string, send: typeof request = request, post: typeof uploadMedia = uploadMedia, cleanup: (file: PickedMedia) => Promise<void> = clearStagedMedia, current: () => boolean = () => true): Promise<MediaMetadata> {
  const pending = await pendingMediaUpload(db, session, path);
  if (!pending || pending.path !== path) throw new Error('There is no saved upload for this bill.');
  const clear = async () => {
    await db.runAsync('DELETE FROM drafts WHERE owner=? AND group_id=? AND body=?', accountOwner(session), uploadDraftKey(path), JSON.stringify(pending));
    await cleanup(pending.file);
  };
  // A previous POST may already have succeeded. Never mint another upload ID.
  let accepted = (await send<MediaList>(session, path)).attachments.find(item => item.id === pending.id);
  if (!accepted) {
    if (!current()) throw new Error('The signed-in account changed.');
    try { accepted = (await post<AttachmentResult>(session, path, pending.file, pending.id, undefined, undefined, current)).attachment; }
    catch (cause) {
      // Even a rejected file stays available for preview, export and recovery.
      if (!current() || cause instanceof ApiError && [400, 413, 415, 422].includes(cause.status)) throw cause;
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

export async function mediaThumbnail(session: Session, media: MediaMetadata, send: typeof request = request): Promise<string> {
  if (media.content_type !== 'application/pdf') return freshMediaUrl(session, media.id, send);
  const result = await send<{ data_url: string }>(session, `/media/${encodeURIComponent(media.id)}/thumbnail`);
  if (typeof result.data_url !== 'string' || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/.test(result.data_url) || result.data_url.length > 100_000) throw new Error('The file preview is unavailable.');
  return result.data_url;
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




export function mediaSize(bytes: number): string { return bytes < 1_048_576 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1_048_576).toFixed(1)} MB`; }

// Upload only after the bill exists. GET/reconciliation in retryMediaUpload also
// makes a lost bill response or upload response safe to retry with the same IDs.
const accountUploads = new WeakMap<Database, Map<string, Promise<number>>>();
export async function retryAccountMediaUploads(db: Database, session: Session, retry = retryMediaUpload, current: () => boolean = () => true): Promise<number> {
  let jobs = accountUploads.get(db);
  if (!jobs) { jobs = new Map(); accountUploads.set(db, jobs); }
  const owner = accountOwner(session), previous = jobs.get(owner);
  const job = (previous ?? Promise.resolve()).catch(() => {}).then(() => drainAccountMediaUploads(db, session, retry, current));
  jobs.set(owner, job);
  try { return await job; } finally { if (jobs.get(owner) === job) jobs.delete(owner); }
}
async function drainAccountMediaUploads(db: Database, session: Session, retry: typeof retryMediaUpload, current: () => boolean): Promise<number> {
  if (!current()) throw new Error('The signed-in account changed.');
  const rows = await db.getAllAsync<{ body: string }>("SELECT body FROM drafts WHERE owner=? AND group_id LIKE 'media-upload:%'", accountOwner(session));
  let failed = 0;
  for (const row of rows) {
    if (!current()) break;
    const upload = JSON.parse(row.body) as PendingMediaUpload | null;
    if (!upload || !/^\/groups\/[^/]+\/expenses\/[^/]+\/attachments$/.test(upload.path)) continue;
    try { await retry(db, session, upload.path, undefined, undefined, undefined, current); }
    catch (error) { if (!current() || error instanceof ApiError && error.status === 401) throw error; failed++; }
  }
  return failed;
}
