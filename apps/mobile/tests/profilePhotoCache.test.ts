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
    move(target: File) { disk.add(target.uri); disk.delete(this.uri); this.uri = target.uri; }
    static async downloadFileAsync(_url: string, file: File) { downloads++; await Promise.resolve(); disk.add(file.uri); return file; }
  }
  const source = readFileSync(new URL('../src/profilePhotoCache.ts', import.meta.url), 'utf8');
  const exports: { cachedProfilePhoto?: Function } = {};
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports, require: (name: string) => {
    if (name === 'expo-file-system') return { File, Paths: { cache: {} } };
    if (name === 'expo-crypto') return { CryptoDigestAlgorithm: { SHA256: 'sha256' }, digestStringAsync: async (_: string, value: string) => createHash('sha256').update(value).digest('hex') };
    if (name === './media' || name === './media.ts') return { freshMediaUrl: async () => { signedUrls++; return 'https://private.test/photo'; } };
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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function nativeCache() {
  const disk = new Map<string, string>();
  const downloads: { file: File; done: ReturnType<typeof deferred<void>> }[] = [];
  const started = deferred<void>();
  class File {
    name: string; uri: string;
    constructor(_base: unknown, name: string) { this.name = name; this.uri = `file:///${name}`; }
    get exists() { return disk.has(this.uri); }
    get size() { return this.exists ? 100 : 0; }
    delete() { disk.delete(this.uri); }
    move(target: File) { disk.set(target.uri, disk.get(this.uri)!); disk.delete(this.uri); this.uri = target.uri; }
    static async downloadFileAsync(_url: string, file: File) {
      const done = deferred<void>(), index = downloads.length; downloads.push({ file, done }); started.resolve();
      await done.promise; disk.set(file.uri, `photo-${index}`); return file;
    }
  }
  const exports: { cachedProfilePhoto?: Function; clearProfilePhotoCache?: Function } = {};
  const require = (name: string): any => {
    if (name === 'expo-file-system') return { File, Paths: { cache: {} } };
    if (name === 'expo-crypto') return { CryptoDigestAlgorithm: { SHA256: 'sha256' }, digestStringAsync: async (_: string, value: string) => createHash('sha256').update(value).digest('hex') };
    if (name === './media' || name === './media.ts') return { freshMediaUrl: async () => 'https://private.test/photo' };
    if (name === './profilePhotoCache.ts') return exports;
    throw new Error(name);
  };
  const evaluate = (source: string, env: object = {}) => runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports, require, ...env });
  evaluate(readFileSync(new URL('../src/profilePhotoCache.ts', import.meta.url), 'utf8'));
  const platform = ts.createSourceFile('mediaPlatform.ts', readFileSync(new URL('../src/mediaPlatform.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
  const clear = platform.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'clearMediaPreviews')!;
  evaluate(`${clear.getText(platform)}; exports.clear = clearMediaPreviews;`, { clearProfilePhotoCache: () => exports.clearProfilePhotoCache?.(), previewFilename: /^merosplit-[0-9a-f-]{36}\.(jpg|png|webp|pdf|bin)$/i });
  const clearMediaPreviews = () => (exports as any).clear(async () => [...disk.keys()].map(uri => ({ name: uri.split('/').pop()!, delete: () => disk.delete(uri) })));
  return { disk, downloads, started, load: exports.cachedProfilePhoto!, clearMediaPreviews };
}

function signOut(clearMediaPreviews: () => Promise<void>) {
  const app = ts.createSourceFile('App.tsx', readFileSync(new URL('../App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let handler: ts.Expression | undefined;
  function visit(node: ts.Node) {
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(app) === 'SettingsRow' && node.attributes.properties.some(prop => ts.isJsxAttribute(prop) && prop.name.getText(app) === 'label' && prop.initializer?.getText(app) === '"Sign out"')) {
      const prop = node.attributes.properties.find(prop => ts.isJsxAttribute(prop) && prop.name.getText(app) === 'onPress') as ts.JsxAttribute;
      handler = (prop.initializer as ts.JsxExpression).expression;
    }
    ts.forEachChild(node, visit);
  }
  visit(app); assert.ok(handler, 'Use the actual Settings sign-out action');
  const events: string[] = [];
  const env = { confirm: async (_title: string, _message: string, action: Function) => action(), storageIsDurable: () => true,
    draftWrites: { current: Promise.resolve() }, flushChatWrites: async () => {}, endPushSession: async () => {}, session: {}, clearMediaPreviews,
    saveSession: async (value: unknown) => { assert.equal(value, null); events.push('session-cleared'); }, changeScope: (value: unknown) => { assert.equal(value, null); events.push('scope-cleared'); } };
  const action = new Function('env', `with(env){${ts.transpileModule(`const action = ${handler.getText(app)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText}; return action;}`)(env);
  return { action, events };
}

const nativeSession = { baseUrl: 'https://api.test', userId: '1' }, nativePhoto = { id: 'photo-v1' };

test('Actual sign-out invalidates a paused native photo download without removing staged bill bytes', { timeout: 1000 }, async () => {
  const cache = nativeCache(), staged = 'file:///merosplit-upload-11111111-1111-4111-8111-111111111111.jpg';
  cache.disk.set(staged, 'financial attachment');
  const work = cache.load(nativeSession, nativePhoto);
  const outcome = work.then(() => 'returned stale photo', () => 'invalidated');
  await cache.started.promise;
  const logout = signOut(cache.clearMediaPreviews); await logout.action();
  assert.deepEqual(logout.events, ['session-cleared', 'scope-cleared']);
  cache.downloads[0].done.resolve();
  assert.equal(await outcome, 'invalidated', 'Prior-account download must never return a usable URI after sign-out');
  assert.deepEqual([...cache.disk.entries()], [[staged, 'financial attachment']], 'Late download cleans only its own file');
});

test('New generation never reuses old work and old completion preserves the newer same-owner photo', { timeout: 1000 }, async () => {
  const cache = nativeCache();
  const old = cache.load(nativeSession, nativePhoto).then(() => 'stale', () => 'invalidated');
  await cache.started.promise; await cache.clearMediaPreviews();
  const current = cache.load(nativeSession, nativePhoto);
  await new Promise(setImmediate);
  assert.equal(cache.downloads.length, 2, 'New sign-in must start its own download');
  cache.downloads[1].done.resolve(); const uri = await current;
  cache.downloads[0].done.resolve(); assert.equal(await old, 'invalidated');
  assert.equal(cache.disk.get(uri), 'photo-1', 'Stale cleanup must not delete or overwrite the current generation');
  assert.equal(await cache.load(nativeSession, nativePhoto), uri); assert.equal(cache.downloads.length, 2, 'Current disk hit remains reusable');
  await cache.clearMediaPreviews(); assert.equal(cache.disk.size, 0, 'Cleanup recognizes completed profile files');
});

test('Invalidation before asynchronous key lookup prevents a native download', { timeout: 1000 }, async () => {
  const cache = nativeCache();
  const outcome = cache.load(nativeSession, nativePhoto).then(() => 'stale', () => 'invalidated');
  await cache.clearMediaPreviews();
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.equal(cache.downloads.length, 0); assert.equal(await outcome, 'invalidated');
});

test('Old completion cannot remove a newer in-flight entry from native download deduplication', { timeout: 1000 }, async () => {
  const cache = nativeCache();
  const old = cache.load(nativeSession, nativePhoto).then(() => 'stale', () => 'invalidated');
  await cache.started.promise; await cache.clearMediaPreviews();
  const current = cache.load(nativeSession, nativePhoto); await new Promise(setImmediate);
  assert.equal(cache.downloads.length, 2);
  cache.downloads[0].done.resolve(); assert.equal(await old, 'invalidated');
  const duplicate = cache.load(nativeSession, nativePhoto); await new Promise(setImmediate);
  assert.equal(cache.downloads.length, 2, 'Old finally must preserve the current generation pending entry');
  cache.downloads[1].done.resolve(); assert.equal(await current, await duplicate); assert.equal(cache.disk.size, 1);
});
