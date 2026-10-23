import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { browserRequestsPaused, pauseBrowserRequests, resumeBrowserRequests, makeBrowserSession, cachedBrowserSession, readBrowserSession, updateBrowserSessionMetadata } from '../src/browserAuth.ts';
import { sessionRequest } from '../src/transport.web.ts';

const base = 'https://merosplit.test';
const alice = { id: 1, email: 'alice@example.invalid', display_name: 'Alice' };
const bob = { id: 2, email: 'bob@example.invalid', display_name: 'Bob' };
function deferred<T>() { let resolve!: (value: T) => void, reject!: (cause: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

test('pause blocks new account requests, drains existing fetches, and allows recipient exchange without old account headers', async () => {
  const originalWindow = globalThis.window, originalDocument = globalThis.document;
  Object.assign(globalThis, { window: { location: { origin: base } }, document: { cookie: 'csrftoken=before' } });
  const active = makeBrowserSession(base, alice), slow = deferred<Response>();
  const calls: { url: string; headers: Headers }[] = [];
  const fetcher: typeof fetch = async (input, init = {}) => { calls.push({ url: String(input), headers: new Headers(init.headers) }); return String(input).endsWith('/slow') ? slow.promise : Response.json({}); };
  try {
    const old = sessionRequest(active, '/api/v1/slow', {}, fetcher);
    let drained = false; const pause = pauseBrowserRequests().then(() => { drained = true; });
    assert.equal(browserRequestsPaused(), true);
    await assert.rejects(sessionRequest(active, '/api/v1/groups', {}, fetcher), /Signing in/);
    assert.equal(calls.length, 1);
    await sessionRequest({ baseUrl: base } as typeof active, '/_allauth/browser/v1/auth/link/exchange', { method: 'POST', headers: { 'X-MeroSplit-Account': '1', 'X-Session-Token': 'old' } }, fetcher);
    assert.equal(calls[1].headers.get('X-MeroSplit-Account'), null);
    assert.equal(calls[1].headers.get('X-Session-Token'), null);
    assert.equal(calls[1].headers.get('X-CSRFToken'), 'before');
    assert.equal(drained, false);
    slow.resolve(Response.json({ oldAccount: true })); await old; await pause;
    document.cookie = 'csrftoken=rotated'; resumeBrowserRequests();
    await sessionRequest(makeBrowserSession(base, bob), '/api/v1/groups', { method: 'POST' }, fetcher);
    assert.equal(calls[2].headers.get('X-MeroSplit-Account'), '2');
    assert.equal(calls[2].headers.get('X-CSRFToken'), 'rotated');
  } finally { resumeBrowserRequests(); Object.assign(globalThis, { window: originalWindow, document: originalDocument }); }
});

test('failed in-flight fetch still drains; response-body work remains the caller auth-generation responsibility', async () => {
  const originalWindow = globalThis.window; Object.assign(globalThis, { window: { location: { origin: base } } });
  try {
    const failed = deferred<Response>();
    const request = sessionRequest(makeBrowserSession(base, alice), '/api/v1/groups', {}, () => failed.promise);
    const failure = assert.rejects(request, /offline/), paused = pauseBrowserRequests(); failed.reject(Error('offline')); await failure; await paused;
    resumeBrowserRequests();
    const body = new ReadableStream({ start() {} });
    const response = await sessionRequest(makeBrowserSession(base, alice), '/api/v1/export', {}, async () => new Response(body));
    await pauseBrowserRequests(); // Headers drain; do not buffer or clone account exports.
    assert.equal(response.bodyUsed, false); await response.body?.cancel();
  } finally { resumeBrowserRequests(); Object.assign(globalThis, { window: originalWindow }); }
});

test('fresh cookie identity wins over cached account; same account keeps its generation until explicit reauthentication', async () => {
  const old = makeBrowserSession(base, alice);
  let observed: RequestInit | undefined;
  const changed = await readBrowserSession(base, old, async (_input, init) => { observed = init; return Response.json(bob); });
  assert.equal(changed?.userId, '2'); assert.equal(changed?.displayName, 'Bob'); assert.notEqual(changed?.token, old.token);
  assert.equal(observed?.credentials, 'same-origin'); assert.equal(observed?.cache, 'no-store'); assert.equal(new Headers(observed?.headers).get('X-MeroSplit-Account'), null);
  const refreshed = await readBrowserSession(base, old, async () => Response.json({ ...alice, display_name: 'Canonical new name' }));
  assert.equal(refreshed?.token, old.token); assert.equal(refreshed?.displayName, 'Canonical new name');
  assert.notEqual(makeBrowserSession(base, alice).token, old.token, 'same-user explicit sign-in has a new generation');
  const upgraded = await readBrowserSession(base, { ...old, token: 'browser-session:1' }, async () => Response.json(alice));
  assert.match(upgraded!.token, /^browser-session:1:[0-9a-f-]{36}$/);
});

test('offline recovery retains only same-origin metadata; definitive missing cookie clears auth and malformed success fails closed', async () => {
  const old = makeBrowserSession(base, alice), raw = JSON.stringify(old);
  assert.deepEqual(cachedBrowserSession(base, raw), old);
  assert.equal(cachedBrowserSession('https://another.test', raw), null);
  assert.equal(cachedBrowserSession(base, '{broken'), null);
  assert.equal(cachedBrowserSession(base, JSON.stringify({ ...old, token: 'secret-server-bearer' })), null);
  assert.deepEqual(await readBrowserSession(base, old, async () => { throw Error('offline'); }), old);
  assert.deepEqual(await readBrowserSession(base, old, async () => new Response('', { status: 503 })), old);
  assert.equal(await readBrowserSession('https://another.test', old, async () => { throw Error('offline'); }), null);
  for (const status of [401, 403]) assert.equal(await readBrowserSession(base, old, async () => new Response('', { status })), null);
  await assert.rejects(readBrowserSession(base, old, async () => Response.json({ id: 1 })), /confirm/);
});

// Execute the production persistence functions without loading Expo's native SQLite
// module in Node; exercise the actual metadata race and token-preservation boundary.
function nativeSessionFunctions(read: () => string | null, write: (value: string | null) => void, fetchSession: typeof readBrowserSession) {
  const source = readFileSync(new URL('../src/native.web.ts', import.meta.url), 'utf8');
  const parsed = ts.createSourceFile('native.web.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const functions = parsed.statements.filter(node => ts.isFunctionDeclaration(node) && ['savedSession', 'saveSession'].includes(node.name?.text ?? '')).map(node => node.getText(parsed).replace(/^export /, '')).join('\n');
  const js = ts.transpile(functions, { target: ts.ScriptTarget.ES2022 });
  return new Function('readPreference', 'writePreference', 'readBrowserSession', 'cachedBrowserSession', 'window', 'SESSION_KEY', `${js}; return { savedSession, saveSession };`)(() => read(), (_key: string, value: string | null) => write(value), fetchSession, cachedBrowserSession, { location: { origin: base } }, 'session') as { savedSession: () => Promise<ReturnType<typeof makeBrowserSession> | null>; saveSession: (value: ReturnType<typeof makeBrowserSession> | null) => Promise<void> };
}

test('actual savedSession cannot overwrite newer cross-tab account metadata; saveSession preserves unique generation', async () => {
  const old = makeBrowserSession(base, alice), next = makeBrowserSession(base, bob); let raw: string | null = JSON.stringify(old);
  const response = deferred<ReturnType<typeof makeBrowserSession> | null>();
  const api = nativeSessionFunctions(() => raw, value => { raw = value; }, () => response.promise);
  const restoring = api.savedSession(); await api.saveSession(next); response.resolve(old);
  await assert.rejects(restoring, /account changed/);
  assert.equal(JSON.parse(raw!).token, next.token);
  const stable = nativeSessionFunctions(() => raw, value => { raw = value; }, async () => next);
  assert.equal((await stable.savedSession())?.token, next.token);
  await stable.saveSession(null); assert.equal(raw, null);
});

test('profile metadata CAS rejects different account and same-account newer generation without overwriting either', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const expected = makeBrowserSession(base, alice), edited = { ...expected, displayName: 'Edited name' };
  let raw: string | null = JSON.stringify(expected), writes = 0;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => raw, setItem: (_key: string, value: string) => { raw = value; writes++; } } });
  try {
    assert.equal(updateBrowserSessionMetadata(expected, edited), true);
    assert.deepEqual(JSON.parse(raw!), edited);
    for (const newer of [makeBrowserSession(base, bob), makeBrowserSession(base, alice)]) {
      raw = JSON.stringify(newer);
      assert.equal(updateBrowserSessionMetadata(expected, edited), false);
      assert.deepEqual(JSON.parse(raw), newer);
    }
    raw = null;
    assert.equal(updateBrowserSessionMetadata(expected, edited), false, 'sign-out must not be undone by late profile metadata');
    raw = JSON.stringify(expected);
    assert.equal(updateBrowserSessionMetadata(expected, makeBrowserSession(base, alice)), false, 'metadata CAS cannot introduce a new auth generation');
    assert.equal(writes, 1);
  } finally { if (original) Object.defineProperty(globalThis, 'localStorage', original); else Reflect.deleteProperty(globalThis, 'localStorage'); }
});

test('blocked metadata reads or writes do not reject an otherwise-current in-memory profile update', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const expected = makeBrowserSession(base, alice), next = { ...expected, displayName: 'New canonical name' };
  try {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('Storage denied'); } });
    assert.equal(updateBrowserSessionMetadata(expected, next), true);
    let raw = JSON.stringify(expected);
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => raw, setItem() { throw new Error('Quota exceeded'); } } });
    assert.equal(updateBrowserSessionMetadata(expected, next), true);
    assert.equal(raw, JSON.stringify(expected));
    raw = JSON.stringify(makeBrowserSession(base, bob));
    assert.equal(updateBrowserSessionMetadata(expected, next), false, 'write failure must not bypass a readable account mismatch');
  } finally { if (original) Object.defineProperty(globalThis, 'localStorage', original); else Reflect.deleteProperty(globalThis, 'localStorage'); }
});
