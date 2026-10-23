import type { MediaMetadata, PickedMedia } from './media';
import type { Session } from './types';
import { chooseBrowserFile, stagedBlob, storeStagedBlob } from './webFiles';
const images = ['image/jpeg', 'image/png', 'image/webp'];
const stagedId = (uri: string) => uri.startsWith('idb://merosplit-upload-') ? uri.slice(6) : null;
export function validateMedia(file: PickedMedia, avatar = false): void {
  if (!(avatar ? images : [...images, 'application/pdf']).includes(file.type)) throw new Error(avatar ? 'Choose a JPEG, PNG or WebP photo.' : 'Choose a JPEG, PNG, WebP image or PDF.');
  if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > (avatar ? 5 : 20) * 1_048_576) throw new Error(`Choose a file above zero and up to ${avatar ? 5 : 20} MB.`);
  if (!file.uri.startsWith('blob:') && !stagedId(file.uri)) throw new Error('Choose a file from this browser.');
}
export async function pickMedia(photo: boolean, avatar = false): Promise<PickedMedia | null> {
  const file = await chooseBrowserFile((photo || avatar ? images : [...images, 'application/pdf']).join(',')); if (!file) return null;
  const picked = { uri: URL.createObjectURL(file), name: file.name, type: file.type, size: file.size };
  try { validateMedia(picked, avatar); return picked; } catch (error) { URL.revokeObjectURL(picked.uri); throw error; }
}
export async function clearPickedMedia(file: PickedMedia): Promise<void> { if (file.uri.startsWith('blob:')) URL.revokeObjectURL(file.uri); }
async function blob(file: PickedMedia): Promise<Blob> {
  const id = stagedId(file.uri); if (id) return stagedBlob(id);
  if (!file.uri.startsWith('blob:')) throw new Error('This file is not available in the browser.');
  return (await fetch(file.uri)).blob();
}
export async function readMediaBytes(uri: string): Promise<Uint8Array> { return new Uint8Array(await (await blob({ uri } as PickedMedia)).arrayBuffer()); }
export async function mediaFilePart(file: PickedMedia): Promise<Blob> { return new File([await blob(file)], file.name, { type: file.type }); }
export async function stageMediaUpload(file: PickedMedia, id: string): Promise<PickedMedia> {
  const extension = ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' } as Record<string, string>)[file.type] ?? 'bin';
  const key = `merosplit-upload-${id}.${extension}`; await storeStagedBlob(key, await blob(file)); return { ...file, uri: `idb://${key}` };
}
export async function clearStagedMedia(file: PickedMedia): Promise<void> { const id = stagedId(file.uri); if (id) await storeStagedBlob(id, null); }
export function browserMediaUrl(session: Session, id: string): string { return `${session.baseUrl}/app/media/${encodeURIComponent(id)}`; }
export async function openPrivateMedia(session: Session, media: MediaMetadata): Promise<void> {
  const opened = window.open(browserMediaUrl(session, media.id), '_blank', 'noopener,noreferrer');
  // Some browsers return null for noopener windows even when presentation succeeds.
  if (opened) opened.opener = null;
}
export async function clearMediaPreview(_media: MediaMetadata): Promise<void> {}
export async function clearMediaPreviews(): Promise<void> {}
