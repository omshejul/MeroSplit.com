import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { ApiError, request } from '../src/api.ts';
import { freshMediaUrl, readPrivateMedia, uploadMedia, validateMedia } from '../src/media.ts';
import type { PickedMedia } from '../src/media.ts';
import type { Session } from '../src/types.ts';

const session: Session = { baseUrl: 'https://example.test', userId: '1', email: 'qa@example.test', token: 'synthetic-private-token' };
const file: PickedMedia = { uri: 'file:///synthetic/photo.png', name: 'photo.png', type: 'image/png', size: 1500 };
const expires = () => new Date(Date.now() + 300_000).toISOString();

// Exercise the installed SDK's real FormData patch and multipart converter.
// Only the native FormData backing array and unused Blob utility need a stub.
function expoSource<T>(relative: string): T {
  const source = readFileSync(new URL(`../node_modules/expo/src/${relative}`, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  runInNewContext(compiled, { exports, Blob, TextEncoder, Uint8Array, require: (name: string) => {
    assert.equal(name, '../../utils/blobUtils');
    return { blobToArrayBufferAsync: () => { throw new Error('A native Blob conversion must not be used for uploaded files.'); } };
  } });
  return exports as T;
}
const { convertFormDataAsync } = expoSource<{ convertFormDataAsync: (data: FormData, boundary: string) => Promise<{ body: Uint8Array; boundary: string }> }>('winter/fetch/convertFormData.ts');
const { installFormDataPatch } = expoSource<{ installFormDataPatch: (formData: typeof FormData) => typeof FormData }>('winter/FormData.ts');
class NativeFormDataBacking { _parts: [string, unknown][] = []; }
const NativeFormData = installFormDataPatch(NativeFormDataBacking as unknown as typeof FormData);

test('Original upload bounds reject unsupported, empty, oversized and remote inputs', () => {
  validateMedia(file, true); validateMedia({ ...file, type: 'application/pdf' });
  validateMedia({ ...file, size: 5 * 1_048_576 }, true);
  validateMedia({ ...file, size: 20 * 1_048_576 });
  for (const invalid of [
    { ...file, size: 0 }, { ...file, size: -1 }, { ...file, size: Number.NaN }, { ...file, size: 1.5 },
    { ...file, size: 20 * 1_048_576 + 1 }, { ...file, type: 'image/heic' }, { ...file, type: 'image/svg+xml' },
    { ...file, type: 'text/html' }, { ...file, uri: 'https://third-party.test/photo.png' },
  ]) assert.throws(() => validateMedia(invalid));
  assert.throws(() => validateMedia({ ...file, size: 5 * 1_048_576 + 1 }, true));
  assert.throws(() => validateMedia({ ...file, type: 'application/pdf' }, true));
});

test('Multipart upload passes the actual Expo converter with filename, MIME, exact bytes and account auth', async () => {
  const previousFormData = globalThis.FormData;
  globalThis.FormData = NativeFormData as unknown as typeof FormData;
  try {
    const optimized = { attachment: { id: 'media-1', name: 'photo.jpg', content_type: 'image/jpeg', size: 800 }, version: 2 };
    const fetcher: typeof fetch = async (url, options) => {
      assert.equal(url, 'https://example.test/api/v1/groups/g/expenses/e/attachments');
      assert.equal(options?.method, 'POST');
      assert.deepEqual(options?.headers, { 'X-Session-Token': session.token }, 'Native fetch must create its own multipart boundary');
      const converted = await convertFormDataAsync(options?.body as FormData, 'MeroSplitTestBoundary');
      const multipart = new TextDecoder().decode(converted.body);
      assert.ok(multipart.includes('content-disposition: form-data; name="id"\r\n\r\nmedia-1'));
      assert.ok(multipart.includes('content-disposition: form-data; name="file"; filename="photo.png"'));
      assert.ok(multipart.includes('content-type: image/png\r\n\r\nSYNTHETIC IMAGE BYTES\r\n'));
      assert.ok(!multipart.includes('[object Object]'));
      assert.ok(options?.signal instanceof AbortSignal);
      return new Response(JSON.stringify(optimized), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    let reads = 0;
    assert.deepEqual(await uploadMedia(session, '/groups/g/expenses/e/attachments', file, 'media-1', fetcher, async uri => {
      reads++; assert.equal(uri, file.uri); return new TextEncoder().encode('SYNTHETIC IMAGE BYTES');
    }), optimized);
    assert.equal(reads, 1);
  } finally { globalThis.FormData = previousFormData; }
});

test('Upload auth/validation failures preserve status and network uncertainty has safe actionable copy', async () => {
  const previousFormData = globalThis.FormData;
  globalThis.FormData = NativeFormData as unknown as typeof FormData;
  try {
    for (const status of [401, 403, 409, 422, 503]) {
      const failed: typeof fetch = async () => new Response(JSON.stringify({ detail: 'Synthetic rejected upload' }), { status, headers: { 'content-type': 'application/json' } });
      await assert.rejects(uploadMedia(session, '/me/avatar', file, 'media-1', failed), error => error instanceof ApiError && error.status === status);
    }
    const unavailable: typeof fetch = async () => new Response('<html>Unavailable</html>', { status: 502 });
    await assert.rejects(uploadMedia(session, '/me/avatar', file, 'media-1', unavailable), error => error instanceof ApiError && error.status === 502 && !error.message.includes('<html>'));
    const network: typeof fetch = async () => { throw new Error('Request failed with synthetic-private-token and private URL'); };
    await assert.rejects(uploadMedia(session, '/me/avatar', file, 'media-1', network), error => error instanceof Error && error.message.includes('Refresh to check whether it finished') && !error.message.includes(session.token));
  } finally { globalThis.FormData = previousFormData; }
});

test('Private reads request fresh authorization and refresh one expired storage URL at most', async () => {
  const paths: string[] = [], reads: string[] = [];
  const send: typeof request = async <T>(active: Session, path: string): Promise<T> => {
    assert.equal(active, session); paths.push(path);
    return { url: `https://private-storage.test/${paths.length}?signature=synthetic`, expires_at: expires() } as T;
  };
  const result = await readPrivateMedia(session, 'media-1', async url => {
    reads.push(url); if (reads.length === 1) throw new Error('Expired storage signature'); return 'opened';
  }, send);
  assert.equal(result, 'opened'); assert.deepEqual(paths, ['/media/media-1/url', '/media/media-1/url']);
  assert.equal(reads.length, 2); assert.notEqual(reads[0], reads[1]);

  let attempts = 0, authorizations = 0;
  const bounded: typeof request = async <T>(): Promise<T> => { authorizations++; return { url: 'https://private-storage.test/unavailable', expires_at: expires() } as T; };
  await assert.rejects(readPrivateMedia(session, 'media-1', async () => { attempts++; throw new Error('Still unavailable'); }, bounded), /Could not open the file/);
  assert.equal(attempts, 2); assert.equal(authorizations, 2);
});

test('Revoked media access stops before reading storage and does not silently reauthorize', async () => {
  let authorizations = 0, reads = 0;
  const denied: typeof request = async <T>(): Promise<T> => { authorizations++; throw new ApiError(403, 'No longer a group member'); };
  await assert.rejects(readPrivateMedia(session, 'media-1', async () => { reads++; return 'must not open'; }, denied), error => error instanceof ApiError && error.status === 403);
  assert.equal(authorizations, 1); assert.equal(reads, 0);
});

test('Metadata rejects insecure or already expired bearer URLs before passing them to native readers', async () => {
  for (const result of [
    { url: 'http://insecure.test/file', expires_at: expires() },
    { url: 'file:///private/file', expires_at: expires() },
    { url: 'https://storage.test/file', expires_at: 'invalid' },
    { url: 'https://storage.test/file', expires_at: new Date(Date.now() - 1000).toISOString() },
  ]) {
    const send: typeof request = async <T>(): Promise<T> => result as T;
    await assert.rejects(freshMediaUrl(session, 'media-1', send), /file link is unavailable/);
  }
});
