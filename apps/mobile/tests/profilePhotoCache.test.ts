import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createHash } from 'node:crypto';
import ts from 'typescript';

test('Profile photos reuse disk bytes, deduplicate downloads and isolate accounts and revisions', async () => {
  const disk = new Set<string>(); let downloads = 0, signedUrls = 0;
  class File {
    uri: string;
    constructor(_base: unknown, name: string) { this.uri = `file:///${name}`; }
    get exists() { return disk.has(this.uri); }
    get size() { return this.exists ? 100 : 0; }
    delete() { disk.delete(this.uri); }
    static async downloadFileAsync(_url: string, file: File) { downloads++; await Promise.resolve(); disk.add(file.uri); return file; }
  }
  const source = readFileSync(new URL('../src/profilePhotoCache.ts', import.meta.url), 'utf8');
  const exports: { cachedProfilePhoto?: Function } = {};
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports, require: (name: string) => {
    if (name === 'expo-file-system') return { File, Paths: { cache: {} } };
    if (name === 'expo-crypto') return { CryptoDigestAlgorithm: { SHA256: 'sha256' }, digestStringAsync: async (_: string, value: string) => createHash('sha256').update(value).digest('hex') };
    if (name === './media') return { freshMediaUrl: async () => { signedUrls++; return 'https://private.test/photo'; } };
    throw new Error(name);
  } });
  const load = exports.cachedProfilePhoto!, session = { baseUrl: 'https://api.test', userId: '1' }, photo = { id: 'photo-v1' };
  const [first, second] = await Promise.all([load(session, photo), load(session, photo)]);
  assert.equal(first, second); assert.equal(downloads, 1); assert.equal(signedUrls, 1);
  assert.equal(await load(session, photo), first); assert.equal(downloads, 1);
  assert.notEqual(await load({ ...session, userId: '2' }, photo), first);
  assert.notEqual(await load(session, { id: 'photo-v2' }), first);
  assert.equal(downloads, 3);
  await load(session, { url: 'https://lh3.googleusercontent.com/google-v1' });
  assert.equal(signedUrls, 3);
});

test('Web photos persist in device cache across remounts and clear on sign-out', async () => {
  const disk = new Map<string, Response>(); let downloads = 0;
  const cache = { match: async (key: string) => disk.get(key)?.clone(), put: async (key: string, value: Response) => { disk.set(key, value); } };
  const source = readFileSync(new URL('../src/profilePhotoCache.web.ts', import.meta.url), 'utf8');
  function module() {
    const exports: { cachedProfilePhoto?: Function; clearProfilePhotoCache?: Function } = {};
    runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports, URL, encodeURIComponent,
      caches: { open: async () => cache, delete: async () => { disk.clear(); } },
      fetch: async () => { downloads++; return new Response(new Blob(['photo'], { type: 'image/jpeg' })); },
      require: () => ({ freshMediaUrl: async () => 'https://private.test/photo' }),
    });
    return exports;
  }
  const session = { baseUrl: 'https://api.test', userId: '1' }, photo = { id: 'photo-v1' }, first = module();
  const url = await first.cachedProfilePhoto!(session, photo);
  assert.ok(url.startsWith('blob:')); assert.equal(downloads, 1);
  const restarted = module();
  const restored = await restarted.cachedProfilePhoto!(session, photo);
  assert.equal(downloads, 1); assert.equal(disk.size, 1);
  await restarted.clearProfilePhotoCache!(); assert.equal(disk.size, 0);
  URL.revokeObjectURL(url); URL.revokeObjectURL(restored);
});
