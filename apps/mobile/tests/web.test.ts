import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { serializedDatabase } from '../src/webDatabase.ts';
import { migrate, readDraft, saveDraft } from '../src/storage.ts';
import { sqliteAdapter } from './sqlite.ts';
import { sessionRequest, requestEmailCode, confirmEmailCode, signOut } from '../src/transport.web.ts';
import type { Session } from '../src/types.ts';
import { openBrowserStorage } from '../src/browserStorage.ts';

const session: Session = { baseUrl: 'https://merosplit.test', userId: '1', email: 'one@example.test', token: 'must-not-leave-browser' };

test('Unavailable OPFS falls back explicitly to temporary SQLite; migration failures preserve durable data', async () => {
  const raw = new DatabaseSync(':memory:'), db = sqliteAdapter(raw);
  let memoryOpens = 0;
  try {
    const temporary = await openBrowserStorage(async () => { throw new Error('Private browsing OPFS unavailable'); }, async () => { memoryOpens++; return db; }, migrate);
    assert.equal(temporary.durable, false);
    await saveDraft(temporary.db, 'one', 'tab-draft', { amount: '125' });
    assert.deepEqual(await readDraft(db, 'one', 'tab-draft'), { amount: '125' });
    assert.equal((await openBrowserStorage(async () => db, async () => { throw new Error('Unexpected fallback'); }, migrate)).durable, true);
    await assert.rejects(openBrowserStorage(async () => db, async () => { memoryOpens++; return db; }, async () => { throw new Error('Newer schema'); }), /Newer schema/);
    assert.equal(memoryOpens, 1);
  } finally { raw.close(); }
});

test('Web cache transactions isolate concurrent queries and roll back only the failing transaction', async () => {
  const raw = new DatabaseSync(':memory:'), db = serializedDatabase(sqliteAdapter(raw));
  try {
    await migrate(db);
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; }), proceed = new Promise<void>(resolve => { release = resolve; });
    const transaction = db.withExclusiveTransactionAsync(async tx => {
      await saveDraft(tx, 'account-one', 'inside', { preserved: false }); entered(); await proceed; throw new Error('Interrupted save');
    });
    await started;
    const outside = saveDraft(db, 'account-two', 'outside', { preserved: true });
    release();
    await assert.rejects(transaction, /Interrupted save/); await outside;
    assert.equal(await readDraft(db, 'account-one', 'inside'), null);
    assert.deepEqual(await readDraft(db, 'account-two', 'outside'), { preserved: true });
  } finally { raw.close(); }
});

test('Browser OTP uses same-origin cookies, fresh CSRF and no bearer credentials', async () => {
  const originalWindow = globalThis.window, originalDocument = globalThis.document, originalFetch = globalThis.fetch;
  const calls: { url: string; init: RequestInit }[] = [];
  Object.assign(globalThis, { window: { location: { origin: session.baseUrl } }, document: { cookie: 'csrftoken=before-login' } });
  globalThis.fetch = async (input, init = {}) => {
    calls.push({ url: String(input), init });
    if (String(input).endsWith('/code/request')) return Response.json({ data: { challenge_id: 'challenge', expires_in: 180, retry_after: 60 } });
    if (String(input).endsWith('/code/confirm')) { document.cookie = 'csrftoken=after-login'; return Response.json({ meta: { is_authenticated: true }, data: { user: { id: 2, email: 'two@example.test' } } }); }
    return Response.json({});
  };
  try {
    const challenge = await requestEmailCode(session.baseUrl, 'two@example.test');
    assert.deepEqual(challenge, { challengeId: 'challenge', expiresIn: 180, retryAfter: 60 });
    const active = await confirmEmailCode(session.baseUrl, challenge.challengeId, '0123');
    assert.equal(active.token, 'browser-session:2');
    assert.deepEqual(JSON.parse(String(calls.find(call => call.url.endsWith('/code/confirm'))?.init.body)), { challenge_id: 'challenge', code: '0123', email_reminders_disclosed: true });
    await sessionRequest(active, '/api/v1/groups', { method: 'POST', body: '{}' });
    await signOut(active);
    for (const call of calls) {
      assert.equal(call.init.credentials, 'same-origin');
      const headers = new Headers(call.init.headers);
      assert.equal(headers.get('X-Session-Token'), null);
      assert.equal(headers.get('X-CSRFToken'), call.url.endsWith('/code/request') || call.url.endsWith('/code/confirm') ? 'before-login' : 'after-login');
    }
    assert.equal(calls.at(-1)?.url, `${session.baseUrl}/_allauth/browser/v1/auth/session`);
    assert.equal(calls.at(-1)?.init.method, 'DELETE');
    assert.throws(() => sessionRequest({ ...session, baseUrl: 'https://another.test' }, '/api/v1/groups'), /account server/);
  } finally { Object.assign(globalThis, { window: originalWindow, document: originalDocument, fetch: originalFetch }); }
});
