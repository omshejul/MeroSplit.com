import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NativeEmailLinkError, inspectNativeEmailLink, exchangeNativeEmailLink, requestNativeEmailLink, renewNativeEmailLink,
  resolveNativeEmailLink, resumeNativeEmailLink,
} from '../src/nativeEmailLinkApi.ts';
import type { Session } from '../src/types.ts';

const base = 'https://merosplit.test', grantId = '01234567-89ab-cdef-0123-456789abcdef';
const otherGrant = '11234567-89ab-cdef-0123-456789abcdef', proof = 'p'.repeat(43);
const oldToken = 'a'.repeat(32), newToken = 'b'.repeat(32);
const current: Session = { baseUrl: base, userId: '1', email: 'one@example.invalid', token: oldToken, displayName: 'Original' };
const link = () => ({ id: grantId, proof });
type Call = { url: string; init: RequestInit };
function authenticated(id = 2, token: string | null = newToken, target: unknown = { kind: 'home' }): Response {
  return Response.json({ meta: { is_authenticated: true, ...(token === null ? {} : { session_token: token }) }, data: {
    user: { id, email: `${id}@example.invalid`, display_name: 'Canonical name' }, target, needs_name: false,
  } });
}
function mock(responses: (Response | Error)[]): { fetcher: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetcher: typeof fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const response = responses.shift();
    if (!response) throw new Error('Unexpected request');
    if (response instanceof Error) throw response;
    return response;
  };
  return { fetcher, calls };
}
const action = (call: Call) => call.url.split('/').at(-1);
const headerToken = (call: Call) => new Headers(call.init.headers).get('X-Session-Token');
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test('native request sends disclosed email and returns existing delivered fallback challenge without caching preauth', async () => {
  const { fetcher, calls } = mock([
    Response.json({ data: { accepted: true, challenge_id: grantId, expires_in: 180, retry_after: 60 }, meta: { session_token: 'c'.repeat(32) } }),
    authenticated(),
  ]);
  assert.deepEqual(await requestNativeEmailLink(`${base}/`, ' two@example.invalid ', fetcher), { challengeId: grantId, expiresIn: 180, retryAfter: 60 });
  await exchangeNativeEmailLink(base, grantId, proof, undefined, fetcher);
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { email: 'two@example.invalid', email_reminders_disclosed: true });
  assert.equal(headerToken(calls[0]), null);
  assert.equal(headerToken(calls[1]), null);
});

test('native exchange uses only app POST body, no browser globals/cookies or proof in URL, and returns actual token', async () => {
  const { fetcher, calls } = mock([authenticated(2, newToken, { kind: 'group', group_id: grantId })]);
  const result = await exchangeNativeEmailLink(base, grantId, proof, undefined, fetcher);
  assert.deepEqual(result, { session: { baseUrl: base, userId: '2', email: '2@example.invalid', displayName: 'Canonical name', token: newToken }, target: { kind: 'group', group_id: grantId }, needsName: false });
  const call = calls[0];
  assert.equal(call.url, `${base}/_allauth/app/v1/auth/link/exchange`);
  assert.ok(!call.url.includes(proof));
  assert.deepEqual(JSON.parse(String(call.init.body)), { grant_id: grantId, proof });
  assert.equal(call.init.method, 'POST'); assert.equal(call.init.credentials, 'omit');
  assert.equal(call.init.cache, 'no-store'); assert.equal(call.init.redirect, 'error');
  assert.ok(call.init.signal instanceof AbortSignal);
  for (const name of ['Cookie', 'X-CSRFToken', 'X-MeroSplit-Account', 'Authorization', 'X-Session-Token']) assert.equal(new Headers(call.init.headers).get(name), null);
});

test('correct current native session reopens a used link via resume and keeps supplied exact token', async () => {
  const { fetcher, calls } = mock([authenticated(1, null)]);
  const result = await resolveNativeEmailLink(base, { id: grantId, proof: null }, () => true, current, fetcher);
  assert.equal(result?.session.token, oldToken); assert.equal(result.session.userId, '1');
  assert.deepEqual(calls.map(action), ['resume']); assert.equal(headerToken(calls[0]), oldToken);
});

test('wrong-account exchange sends current token for server flush and adopts only the rotated token', async () => {
  const { fetcher, calls } = mock([Response.json({}, { status: 400 }), authenticated()]);
  const result = await resolveNativeEmailLink(base, link(), () => true, current, fetcher);
  assert.equal(result?.session.userId, '2'); assert.equal(result.session.token, newToken);
  assert.deepEqual(calls.map(action), ['resume', 'exchange']);
  assert.equal(headerToken(calls[0]), oldToken); assert.equal(headerToken(calls[1]), oldToken);
  assert.equal(current.userId, '1'); assert.equal(current.token, oldToken);
});

for (const status of [401, 410]) test(`definitively rejected current token${status} is dropped before a fresh proof exchange`, async () => {
  const { fetcher, calls } = mock([Response.json({}, { status }), authenticated()]);
  const result = await resolveNativeEmailLink(base, link(), () => true, current, fetcher);
  assert.equal(result?.session.userId, '2');
  assert.deepEqual(calls.map(action), ['resume', 'exchange']);
  assert.equal(headerToken(calls[0]), oldToken); assert.equal(headerToken(calls[1]), null);
});

test('lost same-account response can resume the surviving token without exchanging twice', async () => {
  const { fetcher, calls } = mock([Response.json({}, { status: 400 }), new TypeError('Synthetic lost response'), authenticated(1, null)]);
  const result = await resolveNativeEmailLink(base, link(), () => true, current, fetcher);
  assert.equal(result?.session.userId, '1'); assert.equal(result.session.token, oldToken);
  assert.deepEqual(calls.map(action), ['resume', 'exchange', 'resume']);
  assert.ok(calls.every(call => headerToken(call) === oldToken));
});

test('lost switched-account response plus deleted oldtoken410 requires renewal and never re-exchanges', async () => {
  const { fetcher, calls } = mock([Response.json({}, { status: 400 }), new TypeError(`Synthetic ${proof} ${newToken}`), Response.json({}, { status: 410 })]);
  await assert.rejects(resolveNativeEmailLink(base, link(), () => true, current, fetcher), error => {
    assert.ok(error instanceof NativeEmailLinkError); assert.equal(error.status, 503);
    assert.match(error.message, /Send a new link/); assert.ok(!error.message.includes(proof)); assert.ok(!error.message.includes(newToken));
    return true;
  });
  assert.deepEqual(calls.map(action), ['resume', 'exchange', 'resume']);
  assert.equal(calls.filter(call => action(call) === 'exchange').length, 1);
  assert.equal(current.token, oldToken);
});

test('anonymous response loss has no recoverable preauth token and requires known-email renewal', async () => {
  const { fetcher, calls } = mock([new TypeError('Synthetic lost response')]);
  await assert.rejects(resolveNativeEmailLink(base, link(), () => true, undefined, fetcher), /Send a new link/);
  assert.deepEqual(calls.map(action), ['exchange']);
});

test('another account is never paired with the old token or a missing rotated token', async () => {
  for (const token of [undefined, oldToken]) {
    const { fetcher } = mock([authenticated(2, token ?? null)]);
    await assert.rejects(exchangeNativeEmailLink(base, grantId, proof, current, fetcher), error => error instanceof NativeEmailLinkError && error.status === 503);
  }
  const { fetcher } = mock([authenticated(2, newToken)]);
  await assert.rejects(resumeNativeEmailLink(base, grantId, current, fetcher), error => error instanceof NativeEmailLinkError && error.status === 503);
});

test('foreign/corrupt/browser session metadata never sends its token to this native server', async () => {
  for (const stale of [{ ...current, baseUrl: 'https://other.invalid' }, { ...current, baseUrl: 'bad-url' }, { ...current, token: 'browser-session:1:synthetic' }]) {
    const { fetcher, calls } = mock([authenticated()]);
    assert.equal((await resolveNativeEmailLink(base, link(), () => true, stale, fetcher))?.session.token, newToken);
    assert.deepEqual(calls.map(action), ['exchange']); assert.equal(headerToken(calls[0]), null);
  }
});

test('no proof never exchanges; failed/revoked/expired proof and rate responses retain their status', async () => {
  const noSession = mock([]);
  await assert.rejects(resolveNativeEmailLink(base, { id: grantId, proof: null }, () => true, undefined, noSession.fetcher), error => error instanceof NativeEmailLinkError && error.status === 400);
  assert.equal(noSession.calls.length, 0);
  for (const status of [400, 429]) {
    const { fetcher, calls } = mock([Response.json({}, { status })]);
    await assert.rejects(resolveNativeEmailLink(base, link(), () => true, undefined, fetcher), error => error instanceof NativeEmailLinkError && error.status === status);
    assert.deepEqual(calls.map(action), ['exchange']);
  }
});

test('known-email renew is anonymous and only provider accepted means sent', async () => {
  const { fetcher, calls } = mock([Response.json({ data: { accepted: true, retry_after: 60 } }), Response.json({ data: { accepted: false, retry_after: 60 } })]);
  assert.equal(await renewNativeEmailLink(base, grantId, fetcher), 60);
  await assert.rejects(renewNativeEmailLink(base, grantId, fetcher), /Could not send a new link/);
  assert.ok(calls.every(call => headerToken(call) === null));
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { grant_id: grantId });
});

test('malformed/unauthenticated success payloads never become native sessions', async () => {
  for (const body of [
    { meta: { is_authenticated: false, session_token: newToken }, data: { user: { id: 2, email: 'two@example.invalid' }, target: { kind: 'home' }, needs_name: false } },
    { meta: { session_token: newToken }, data: { user: { id: 2, email: 'two@example.invalid' }, target: { kind: 'home' }, needs_name: false } },
    { meta: { is_authenticated: true }, data: { user: { id: 2, email: 'two@example.invalid' }, target: { kind: 'home' }, needs_name: false } },
    { meta: { is_authenticated: true, session_token: newToken }, data: { user: { id: 2, email: '' }, target: { kind: 'home' }, needs_name: false } },
    { meta: { is_authenticated: true, session_token: newToken }, data: { user: { id: 2, email: 'two@example.invalid' }, target: { kind: 'url', url: 'https://other.invalid' }, needs_name: false } },
  ]) {
    const { fetcher } = mock([Response.json(body)]);
    await assert.rejects(exchangeNativeEmailLink(base, grantId, proof, undefined, fetcher), error => error instanceof NativeEmailLinkError && error.status === 503);
  }
  const { fetcher } = mock([new Response(`Synthetic private ${proof}`, { status: 200 })]);
  await assert.rejects(exchangeNativeEmailLink(base, grantId, proof, undefined, fetcher), error => error instanceof NativeEmailLinkError && !error.message.includes(proof));
});

test('newer auth epoch during resume stops the old link before exchange', async () => {
  const response = deferred<Response>(), calls: Call[] = [];
  let active = true;
  const fetcher: typeof fetch = async (url, init = {}) => { calls.push({ url: String(url), init }); return response.promise; };
  const result = resolveNativeEmailLink(base, link(), () => active, current, fetcher);
  active = false; response.resolve(Response.json({}, { status: 400 }));
  assert.equal(await result, null); assert.deepEqual(calls.map(action), ['resume']);
});

test('captured link and current token remain immutable across awaited resume', async () => {
  const response = deferred<Response>(), calls: Call[] = [], incoming = link(), saved = { ...current };
  const fetcher: typeof fetch = async (url, init = {}) => { calls.push({ url: String(url), init }); return calls.length === 1 ? response.promise : authenticated(); };
  const result = resolveNativeEmailLink(base, incoming, () => true, saved, fetcher);
  incoming.id = otherGrant; incoming.proof = 'q'.repeat(43); saved.token = 'c'.repeat(32); saved.userId = '3';
  response.resolve(Response.json({}, { status: 400 }));
  assert.equal((await result)?.session.userId, '2');
  assert.equal(headerToken(calls[1]), oldToken);
  assert.deepEqual(JSON.parse(String(calls[1].init.body)), { grant_id: grantId, proof });
});

test('newer auth epoch discards late exchange acceptance without retaining token/proof', async () => {
  const response = deferred<Response>(), started = deferred<void>();
  let active = true;
  const fetcher: typeof fetch = async () => { started.resolve(); return response.promise; };
  const result = resolveNativeEmailLink(base, link(), () => active, undefined, fetcher);
  await started.promise; active = false; response.resolve(authenticated());
  assert.equal(await result, null);
  let calls = 0;
  await assert.rejects(resumeNativeEmailLink(base, grantId, { ...current, baseUrl: 'https://other.invalid' }, async () => { calls++; return authenticated(); }));
  assert.equal(calls, 0);
});

test('invalid native base never sends credentials or link proof', async () => {
  for (const invalid of ['https://user:password@merosplit.test', 'https://merosplit.test?token=synthetic', 'https://merosplit.test#proof=synthetic', 'file:///tmp/example']) {
    let calls = 0;
    await assert.rejects(exchangeNativeEmailLink(invalid, grantId, proof, current, async () => { calls++; return authenticated(); }));
    assert.equal(calls, 0);
  }
});


for(const status of [401,410]) test(`native inspection retries definitively revoked token ${status} anonymously without consuming proof`,async()=>{
  const {fetcher,calls}=mock([Response.json({}, {status}),Response.json({data:{email:'two@example.invalid',user_id:2,purpose:'login',current_user_id:null,current_email:null}})]);
  assert.deepEqual(await inspectNativeEmailLink(base,grantId,proof,current,fetcher),{email:'two@example.invalid',userId:2,purpose:'login',currentUserId:null,currentEmail:null});
  assert.deepEqual(calls.map(action),['inspect','inspect']); assert.equal(headerToken(calls[0]),oldToken);assert.equal(headerToken(calls[1]),null);
  assert.ok(calls.every(call=>!call.url.includes(proof)));
});

test('confirmed native switch skips resume and retains bound old-account identity on rejection or uncertain response',async()=>{
  for(const status of [200,400,410,503]) {
    const {fetcher,calls}=mock([status===200?authenticated():Response.json({}, {status})]);
    const run=resolveNativeEmailLink(base,link(),()=>true,current,fetcher,1);
    if(status===200) assert.equal((await run)?.session.userId,'2');else await assert.rejects(run);
    assert.deepEqual(calls.map(action),['exchange']);assert.equal(headerToken(calls[0]),oldToken);
    assert.deepEqual(JSON.parse(String(calls[0].init.body)),{grant_id:grantId,proof,switch_from_user_id:1});
  }
});
