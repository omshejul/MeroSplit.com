import { clearProfilePhotoCache } from './profilePhotoCache.ts';
import { readPrivateMedia } from './media.ts';
import type { MediaMetadata, PickedMedia } from './media.ts';
import type { Session } from './types.ts';

const imageTypes = ['image/jpeg', 'image/png', 'image/webp'];
const extensions: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };
const mimeForExtension: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', pdf: 'application/pdf' };
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
    const result = await picker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsMultipleSelection: false, allowsEditing: avatar, ...(avatar ? { aspect: [1, 1] as [number, number] } : {}), quality: 0.85,
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
  clearProfilePhotoCache();
  try {
    for (const file of await cacheFiles()) if (previewFilename.test(file.name) || /^merosplit-avatar-[a-f0-9]{64}(?:-[0-9]+)?\.img$/.test(file.name)) {
      try { file.delete(); } catch { /* Continue cleaning after a single-file failure. */ }
    }
  } catch { /* Preview cleanup must not prevent account sign-out or deletion. */ }
}

export async function readMediaBytes(uri: string): Promise<Uint8Array> { const { File } = await import('expo-file-system'); return new File(uri).bytes(); }
export async function mediaFilePart(file: PickedMedia, readBytes: (uri: string) => Promise<Uint8Array>): Promise<Blob> { return { name: file.name, type: file.type, bytes: () => readBytes(file.uri) } as unknown as Blob; }

export async function localMediaUrl(file: PickedMedia): Promise<string> { return file.uri; }
export function clearLocalMediaUrl(_uri: string): void {}
export async function openLocalMedia(file: PickedMedia, _uri: string): Promise<void> {
  const { File } = await import('expo-file-system');
  const saved = new File(file.uri);
  if (!await saved.canPreview({ mimeType: file.type })) throw new Error('No file viewer is available.');
  await saved.preview({ title: file.name, mimeType: file.type });
}
export async function mediaBase64(file: PickedMedia): Promise<string> { const { File } = await import('expo-file-system'); return new File(file.uri).base64(); }
