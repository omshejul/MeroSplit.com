import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { prepareGoogle, finishGoogle, type GoogleAttempt } from '../src/googleSignIn.ts';
import type { Session } from '../src/types.ts';

test('Apple connection errors distinguish confirmed ownership, legacy conflict and generic failures', async () => {
  const original = globalThis.fetch;
  const current: Session = { baseUrl: 'https://merosplit.test', userId: '7', email: 'owner@example.invalid', token: 'unchanged-session' };
  const connect: GoogleAttempt = { session: current, process: 'connect', client: 'app', provider: 'apple', nonce: 'a'.repeat(64), state: 'b'.repeat(64), expiresAt: Date.now() + 180_000 };
  try {
    for (const [code, message] of [
      ['apple_already_connected', 'This Apple ID is connected to another MeroSplit account. To access that account, sign out, then choose “Continue with Apple” on the sign-in screen.'],
      ['apple_email_conflict', "Couldn't connect Apple. Please try again."],
      ['apple_unavailable', "Couldn't connect Apple. Please try again."],
    ]) {
      globalThis.fetch = async () => Response.json({ errors: [{ code }] }, { status: 409 });
      await assert.rejects(finishGoogle(connect, 'signed', current, () => true, { state: connect.state!, authorization_code: 'one' }), error => {
        assert.equal((error as Error).message, message); assert.equal((error as Error & { code: string }).code, code); return true;
      });
      assert.equal(current.token, 'unchanged-session');
    }
    globalThis.fetch = async () => Response.json({ errors: [{ code: 'apple_email_conflict' }] }, { status: 409 });
    await assert.rejects(finishGoogle({ ...connect, process: 'login' }, 'signed', undefined, () => true, { state: connect.state!, authorization_code: 'one' }), /Sign in with your email first/);
  } finally { globalThis.fetch = original; }
});

const base = 'https://merosplit.test', nonce = 'a'.repeat(64), state = 'b'.repeat(64);
const session: Session = { baseUrl: base, userId: '1', email: 'relay@privaterelay.appleid.com', token: 'session' };
const attempt: GoogleAttempt = { session: { ...session, token: 'preauth' }, process: 'login', client: 'app', provider: 'apple', nonce, state, expiresAt: Date.now() + 180_000 };
const authenticated = { data: { user: { id: 1, email: session.email } }, meta: { is_authenticated: true, session_token: 'allauth-session' } };
function mock(replies: (object | Error)[]) {
  const original = globalThis.fetch, calls: { url: string; body: object }[] = [];
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), body: JSON.parse(init?.body as string) }); const response = replies.shift(); assert.ok(response); if (response instanceof Error) throw response; return Response.json(response); };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test('Apple uses same allauth session parser with state/code bound to app-only challenge', async () => {
  const wire = mock([{ data: { nonce, state, expires_in: 180, client_id: 'com.omshejul.splitdumb' }, meta: { session_token: 'preauth' } }, authenticated]);
  try {
    const prepared = await prepareGoogle(base, 'login', 'app', undefined, 'apple');
    const adopted = await finishGoogle(prepared, 'signed-id-token', undefined, () => true, { state, authorization_code: 'one-use-code', given_name: 'Initial' });
    assert.deepEqual(adopted, { ...session, token: 'allauth-session' });
    assert.deepEqual(wire.calls[1].body, { process: 'login', id_token: 'signed-id-token', state, authorization_code: 'one-use-code', given_name: 'Initial' });
    assert.ok(wire.calls.every(call => call.url.startsWith(base + '/_allauth/app/v1/auth/apple/')));
  } finally { wire.restore(); }
});

for (const bad of [{ state: 'bad' }, { client_id: 'other' }, { expires_in: 0 }]) test(`Apple rejects malformed challenge ${Object.keys(bad)[0]}`, async () => {
  const wire = mock([{ data: { nonce, state, expires_in: 180, client_id: 'com.omshejul.splitdumb', ...bad }, meta: { session_token: 'preauth' } }]);
  try { await assert.rejects(prepareGoogle(base, 'login', 'app', undefined, 'apple')); } finally { wire.restore(); }
});

test('Apple state, expiry, stale actor and offline errors never adopt or repeat a proof', async () => {
  const wire = mock([Error('private network detail')]);
  try {
    for (const value of [{ ...attempt, expiresAt: 0 }, attempt]) await assert.rejects(finishGoogle(value, 'signed', undefined, () => true, { state: 'wrong', authorization_code: 'one' }));
    await assert.rejects(finishGoogle(attempt, 'signed', undefined, () => false, { state, authorization_code: 'one' }));
    assert.equal(wire.calls.length, 0);
    await assert.rejects(finishGoogle(attempt, 'signed', undefined, () => true, { state, authorization_code: 'one' }), /Apple.*online/);
    assert.equal(wire.calls.length, 1);
  } finally { wire.restore(); }
});

function extract(file: string, choose: (node: ts.Node, source: ts.SourceFile) => string) {
  const source = ts.createSourceFile(file, readFileSync(new URL(file, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let text = ''; function visit(node: ts.Node) { text = choose(node, source) || text; ts.forEachChild(node, visit); } visit(source); assert.ok(text); return text;
}

test('actual official native Apple flow binds raw nonce/state; cancellation and stale actors stay unadopted', async () => {
  const callback = extract('../src/AppleSignInButton.ios.tsx', (node, source) => ts.isCallExpression(node) && node.expression.getText(source) === 'onAuthenticate' ? node.arguments[0].getText(source) : '');
  let cancelled = true, finishes = 0, calls = 0;
  const AppleAuthentication = { AppleAuthenticationScope: { FULL_NAME: 0, EMAIL: 1 }, signInAsync: async (options: object) => { calls++; assert.deepEqual(options, { requestedScopes: [0, 1], nonce, state }); if (cancelled) throw { code: 'ERR_REQUEST_CANCELED' }; return { identityToken: 'signed', authorizationCode: 'one', state, fullName: null }; } };
  const deps = { prepareGoogle: async () => attempt, finishGoogle: async () => { finishes++; return session; }, AppleAuthentication, baseUrl: base, process: 'login', current: undefined };
  const run = new Function(...Object.keys(deps), `${ts.transpile(`const run = ${callback}`, { target: ts.ScriptTarget.ES2022 })}; return run;`)(...Object.values(deps));
  assert.equal(await run(() => true), null); assert.equal(finishes, 0);
  cancelled = false; assert.equal(await run(() => true), session); assert.equal(finishes, 1);
  assert.equal(await run(() => false), null); assert.equal(calls, 2);
});

test('actual account deletion warns on unconfirmed revocation after normal local cleanup', async () => {
  const flow = extract('../App.tsx', (node, source) => ts.isFunctionDeclaration(node) && node.name?.text === 'deleteAccount' ? node.getText(source) : '');
  for (const outcome of ['manual_required', 'unknown', 'revoked', undefined]) {
    const calls: string[] = [];
    const deps = { session, owner: 'scope', draftWrites: { current: Promise.resolve() }, flushChatWrites: async () => {}, accountDeletionInput: () => ({}), request: async () => ({ deleted: true, apple_revocation: outcome }), push: { clear: async () => calls.push('push') }, setPushTarget: () => {}, getDatabase: async () => ({}), clearAccountMediaUploads: async () => {}, wipeAccount: async () => calls.push('wipe'), clearMediaPreviews: async () => {}, saveSession: async () => calls.push('signout'), changeScope: () => calls.push('scope'), setNotice: (message: string, level: string) => { assert.match(message, /could not confirm/); assert.equal(level, 'warning'); calls.push('manual'); } };
    const run = new Function(...Object.keys(deps), `${ts.transpile(flow, { target: ts.ScriptTarget.ES2022 })}; return deleteAccount;`)(...Object.values(deps));
    await run({ confirmation: 'delete', email: session.email });
    assert.deepEqual(calls, ['push', 'wipe', 'signout', 'scope', ...(['manual_required', 'unknown'].includes(outcome ?? '') ? ['manual'] : [])]);
  }
});
