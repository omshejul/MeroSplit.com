import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { prepareGoogle, finishGoogle, GOOGLE_WEB_CLIENT_ID, type GoogleAttempt } from '../src/googleSignIn.ts';
import type { Session } from '../src/types.ts';

const base = 'https://merosplit.test', nonce = 'a'.repeat(64);
const alice: Session = { baseUrl: base, userId: '1', email: 'alice@example.invalid', token: 'session-a' };
const attempt: GoogleAttempt = { session: { ...alice, userId: '', token: 'pre-auth' }, process: 'login', client: 'app', nonce, expiresAt: Date.now() + 180_000 };
const authenticated = (id = 1) => ({ data: { user: { id, email: alice.email } }, meta: { is_authenticated: true, session_token: 'server-session' } });
function fetchReplies(replies: (object | Response | Error)[]) {
  const original = globalThis.fetch, calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const value = replies.shift();
    assert.notEqual(value, undefined, 'unexpected outbound call');
    if (value instanceof Error) throw value;
    return value instanceof Response ? value : Response.json(value);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test('native challenge token remains ephemeral; Google token yields the existing allauth session shape', async () => {
  const mock = fetchReplies([{ data: { nonce, client_id: GOOGLE_WEB_CLIENT_ID, expires_in: 180 }, meta: { session_token: 'pre-auth' } }, authenticated()]);
  try {
    const value = await prepareGoogle(base, 'login', 'app');
    assert.equal(value.session.token, 'pre-auth');
    const signed = await finishGoogle(value, 'synthetic-id-token', undefined, () => true);
    assert.deepEqual(signed, { ...alice, token: 'server-session' });
    assert.equal(mock.calls[1].init.headers!['X-Session-Token' as keyof HeadersInit], 'pre-auth');
    assert.deepEqual(JSON.parse(mock.calls[1].init.body as string), { process: 'login', id_token: 'synthetic-id-token' });
    assert.ok(mock.calls.every(call => call.url.startsWith(base + '/_allauth/app/v1/auth/google/')));
  } finally { mock.restore(); }
});

test('connect retains exact local account generation and does not require a new server session token', async () => {
  const mock = fetchReplies([{ data: { nonce, client_id: GOOGLE_WEB_CLIENT_ID, expires_in: 180 } }, authenticated()]);
  try {
    const value = await prepareGoogle(base, 'connect', 'app', alice);
    assert.equal(value.session.token, alice.token);
    assert.equal(await finishGoogle(value, 'synthetic', alice, () => true), alice);
  } finally { mock.restore(); }
});

test('browser successful identity becomes metadata only, never a server bearer', async () => {
  const mock = fetchReplies([authenticated()]);
  try {
    const value = await finishGoogle({ ...attempt, client: 'browser' }, 'synthetic', undefined, () => true);
    assert.match(value.token, /^browser-session:1:/);
    assert.notEqual(value.token, 'server-session');
  } finally { mock.restore(); }
});

test('expiry and stale generation stop before HTTP; a changed account after HTTP cannot adopt its reply', async () => {
  const mock = fetchReplies([authenticated()]);
  try {
    await assert.rejects(finishGoogle({ ...attempt, expiresAt: 0 }, 'synthetic', undefined, () => true), /expired/);
    await assert.rejects(finishGoogle(attempt, 'synthetic', undefined, () => false), /changed/);
    assert.equal(mock.calls.length, 0);
    let checks = 0;
    await assert.rejects(finishGoogle(attempt, 'synthetic', undefined, () => ++checks === 1), /changed/);
    assert.equal(mock.calls.length, 1);
  } finally { mock.restore(); }
});

for (const bad of [{ nonce: 'bad' }, { client_id: 'wrong' }, { expires_in: 0 }, { expires_in: 301 }, { expires_in: '180' }]) {
  test(`malformed Google challenge fails closed: ${Object.keys(bad)[0]}=${Object.values(bad)[0]}`, async () => {
    const mock = fetchReplies([{ data: { nonce, client_id: GOOGLE_WEB_CLIENT_ID, expires_in: 180, ...bad }, meta: { session_token: 'pre-auth' } }]);
    try { await assert.rejects(prepareGoogle(base, 'login', 'app'), /prepare/); }
    finally { mock.restore(); }
  });
}

test('offline/provider HTML/conflict responses expose safe retry copy only', async () => {
  const mock = fetchReplies([Error('private transport detail'), new Response('private upstream body'), Response.json({ errors: [{ code: 'google_email_conflict' }] }, { status: 409 })]);
  try {
    await assert.rejects(prepareGoogle(base, 'login', 'app'), /when online/);
    await assert.rejects(prepareGoogle(base, 'login', 'app'), /temporarily unavailable/);
    await assert.rejects(prepareGoogle(base, 'login', 'app'), /email first/);
  } finally { mock.restore(); }
});

test('connect rejects wrong account before challenge and wrong returned identity after proof', async () => {
  const mock = fetchReplies([authenticated(2)]);
  try {
    await assert.rejects(prepareGoogle(base, 'connect', 'app'), /account changed/);
    await assert.rejects(prepareGoogle('https://other.test', 'connect', 'app', alice), /account changed/);
    assert.equal(mock.calls.length, 0);
    await assert.rejects(finishGoogle({ ...attempt, process: 'connect' }, 'synthetic', alice, () => true), /account changed/);
  } finally { mock.restore(); }
});

function appFlow(active: Session | null = null, platform = 'web') {
  const parsed = ts.createSourceFile('App.tsx', readFileSync(new URL('../App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let flow = '';
  function visit(node: ts.Node) { if (ts.isFunctionDeclaration(node) && node.name?.text === 'finishGoogleSignIn') flow = node.getText(parsed); ts.forEachChild(node, visit); }
  visit(parsed); assert.ok(flow);
  const calls: string[] = [], activeSessionRef = { current: active }, authEpoch = { current: 0 }, authHeldRef = { current: false };
  const context = {
    activeSessionRef, authEpoch, authHeldRef, Platform: { OS: platform }, draftWrites: { current: Promise.resolve() }, validatedBrowserSession: { current: '' }, emailEntryRef: { current: null },
    setCheckingCookie: () => {}, pauseAccountRequests: async () => { calls.push('pause'); }, resumeAccountRequests: () => { calls.push('resume'); },
    saveSession: async () => { calls.push('save'); }, changeScope: () => { calls.push('scope'); }, setChallenge: () => { calls.push('challenge'); }, setCode: () => { calls.push('code'); },
    providerConnections: { refresh: () => calls.push('connections') }, syncAccount: async () => { calls.push('sync'); }, setNotice: () => { calls.push('notice'); }, endPushSession: async () => { calls.push('push-end'); }, push: { clear: async () => {} }, clearMediaPreviews: async () => {},
  };
  const run = new Function(...Object.keys(context), `${ts.transpile(flow, { target: ts.ScriptTarget.ES2022 })}; return finishGoogleSignIn;`)(...Object.values(context));
  return { run, calls, activeSessionRef, authEpoch, authHeldRef };
}

test('actual App adoption preserves drafts on cancellation/failure and releases browser pause', async () => {
  for (const fail of [false, true]) {
    const app = appFlow();
    try { await app.run('login', async () => { if (fail) throw Error('cancelled/offline'); return null; }); } catch {}
    assert.deepEqual(app.calls, ['pause', 'resume']);
    assert.equal(app.authHeldRef.current, false);
  }
});

test('actual App uses existing persistence/scope/sync owner; explicit connect never resets data scope', async () => {
  const login = appFlow();
  await login.run('login', async () => alice);
  assert.ok(login.calls.indexOf('save') < login.calls.indexOf('scope'));
  assert.ok(login.calls.indexOf('scope') < login.calls.indexOf('sync'));
  const connect = appFlow(alice);
  await connect.run('connect', async () => alice);
  assert.deepEqual(connect.calls, ['connections', 'notice']);
});

test('actual App rejects stale account response before persistence and permits expired-account reauthentication', async () => {
  const app = appFlow();
  await app.run('login', async () => { app.activeSessionRef.current = alice; return alice; });
  assert.deepEqual(app.calls, ['pause', 'resume']);
  const reauth = appFlow(alice, 'ios');
  await reauth.run('login', async () => ({ ...alice, token: 'renewed' }));
  assert.deepEqual(reauth.calls, ['save', 'push-end', 'scope', 'challenge', 'code', 'sync']);
});

test('actual native orchestration always chooses interactive nonce-bound flow and leaves cancellation unadopted', async () => {
  const source = ts.createSourceFile('GoogleSignInButton.tsx', readFileSync(new URL('../src/GoogleSignInButton.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let body = '';
  function visit(node: ts.Node) { if (ts.isCallExpression(node) && node.expression.getText(source) === 'onAuthenticate') body = node.arguments[0].getText(source); ts.forEachChild(node, visit); }
  visit(source); assert.ok(body);
  let config: unknown, result: unknown = { type: 'cancelled' }, finishes = 0, dialogs = 0;
  const sdk = { configure: (value: unknown) => { config = value; }, checkPlayServices: async (resolve: boolean) => { assert.equal(resolve, false); }, presentExplicitSignIn: async () => { dialogs++; return result; } };
  const deps = { prepareGoogle: async () => attempt, finishGoogle: async () => { finishes++; return alice; }, baseUrl: base, process: 'login', current: undefined, GoogleOneTapSignIn: sdk, GOOGLE_WEB_CLIENT_ID, GOOGLE_IOS_CLIENT_ID: 'public-ios-client' };
  const run = new Function(...Object.keys(deps), `${ts.transpile(`const run = ${body}`, { target: ts.ScriptTarget.ES2022 })}; return run;`)(...Object.values(deps));
  assert.equal(await run(() => true), null);
  assert.equal(finishes, 0);
  assert.deepEqual(config, { webClientId: GOOGLE_WEB_CLIENT_ID, iosClientId: 'public-ios-client', nonce, offlineAccess: false, autoSelectOnSignIn: false });
  result = { type: 'success', data: { idToken: 'synthetic' } };
  assert.equal(await run(() => true), alice);
  assert.equal(finishes, 1);
  assert.equal(await run(() => false), null);
  assert.equal(dialogs, 2);
});

test('web handoff is same-origin and goes through the App draft/account boundary before navigation', async () => {
  const source = ts.createSourceFile('button.web.tsx', readFileSync(new URL('../src/GoogleSignInButton.web.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let body = '';
  function visit(node: ts.Node) { if (ts.isCallExpression(node) && node.expression.getText(source) === 'onAuthenticate') body = node.arguments[0].getText(source); ts.forEachChild(node, visit); }
  visit(source); assert.ok(body);
  const forms: any[] = [], submitted: any[] = [];
  const window = { location: { origin: base } };
  const document = { cookie: 'csrftoken=synthetic-csrf', body: { appendChild: (form:any) => forms.push(form) }, createElement: (tag:string):any => tag === 'input' ? {} : {
    children: [] as any[], appendChild(input:any) { this.children.push(input); },
    submit() { submitted.push({ action:this.action,method:this.method,fields:Object.fromEntries(this.children.map((input:any) => [input.name,input.value])) }); },
    remove() { forms.splice(forms.indexOf(this),1); },
  } };
  const make = (baseUrl = base) => new Function('window', 'document', 'baseUrl', 'process', 'current', `${ts.transpile(`const run = ${body}`, { target: ts.ScriptTarget.ES2022 })}; return run;`)(window, document, baseUrl, 'connect', alice);
  await make()(() => false); assert.deepEqual(submitted, []);
  await make()(() => true); assert.deepEqual(submitted, [{action:'/auth/google',method:'POST',fields:{process:'connect',csrfmiddlewaretoken:'synthetic-csrf',account:'1'}}]); assert.equal(forms.length,0);
  await assert.rejects(make('https://attacker.invalid')(() => true), /account server/);
  document.cookie = ''; await assert.rejects(make()(() => true), /Reload MeroSplit/); assert.equal(submitted.length,1);

});

async function browserPage(data: object, loaded = true) {
  const html = readFileSync(new URL('../../api/ledger/templates/ledger/google_signin.html', import.meta.url), 'utf8');
  const script = html.match(/<script nonce="[^\n]+">([\s\S]*?)<\/script>/)![1];
  const calls: { path: string; init: RequestInit }[] = [], config: object[] = [], buttons: object[] = [], redirects: string[] = [];
  const status = { textContent: '' };
  const nodes = { 'google-data': { textContent: JSON.stringify(data), remove() {} }, status, google: { replaceChildren() {} } };
  const api = { initialize: (value: object) => config.push(value), renderButton: (_node: unknown, value: object) => buttons.push(value) };
  const window = { google: loaded ? { accounts: { id: api } } : undefined, location: { origin: base, replace: (value: string) => redirects.push(value) } };
  const document = { cookie: 'csrftoken=synthetic-csrf', getElementById: (id: keyof typeof nodes) => nodes[id], createElement: () => ({ remove() {} }), head: { appendChild: (element: { onload: () => void }) => queueMicrotask(() => element.onload()) } };
  const fetcher = async (path: string, init: RequestInit) => { calls.push({ path, init }); return Response.json(path.endsWith('challenge') ? { data: { nonce, client_id: GOOGLE_WEB_CLIENT_ID, expires_in: 180 } } : authenticated()); };
  await new Function('window', 'document', 'fetch', 'setTimeout', 'clearTimeout', `return ${script.trim()}`)(window, document, fetcher, () => 1, () => {});
  return { calls, config, buttons, redirects, status };
}

test('actual GIS page uses fixed redirect/nonce/no automatic login without changing SQLite isolation', async () => {
  const page = await browserPage({ process: 'connect', account: '1', clientId: GOOGLE_WEB_CLIENT_ID });
  assert.deepEqual(page.config, [{ client_id: GOOGLE_WEB_CLIENT_ID, nonce, ux_mode: 'redirect', login_uri: base + '/auth/google/callback', use_fedcm_for_button: false, auto_select: false, button_auto_select: false }]);
  assert.equal(page.calls.length, 1);
  assert.equal(page.calls[0].path, '/_allauth/browser/v1/auth/google/challenge');
  assert.equal((page.calls[0].init.headers as Record<string, string>)['X-CSRFToken'], 'synthetic-csrf');
  assert.equal((page.calls[0].init.headers as Record<string, string>)['X-MeroSplit-Account'], '1');
  assert.equal((page.calls[0].init.headers as Record<string, string>)['X-Session-Token'], undefined);
  assert.deepEqual(page.buttons, [{ theme: 'outline', size: 'large', text: 'continue_with', state: 'connect' }]);
  assert.deepEqual(page.redirects, []);
});

test('missing GIS global fails safely; a fresh return/retry page can load normally', async () => {
  const failed = await browserPage({ process: 'login', clientId: GOOGLE_WEB_CLIENT_ID }, false);
  assert.match(failed.status.textContent, /could not load/);
  assert.deepEqual(failed.config, []);
  const retry = await browserPage({ process: 'login', clientId: GOOGLE_WEB_CLIENT_ID });
  assert.equal(retry.config.length, 1);
});

test('actual redirect bridge sends credential only to same-origin allauth, then returns to fixed app path', async () => {
  const page = await browserPage({ process: 'login', credential: 'synthetic-token' });
  assert.equal(page.calls.length, 1);
  assert.equal(page.calls[0].path, '/_allauth/browser/v1/auth/google/token');
  assert.deepEqual(JSON.parse(page.calls[0].init.body as string), { process: 'login', id_token: 'synthetic-token' });
  assert.equal(page.calls[0].init.credentials, 'same-origin');
  assert.deepEqual(page.config, []);
  assert.deepEqual(page.redirects, ['/app/']);
});
