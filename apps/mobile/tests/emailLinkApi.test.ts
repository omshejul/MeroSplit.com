import test from 'node:test';
import assert from 'node:assert/strict';
import { exchangeEmailLink, resumeEmailLink, renewEmailLink, requestEmailLink, resolveEmailLink, EmailLinkError } from '../src/emailLinkApi.ts';
import { pauseBrowserRequests, resumeBrowserRequests } from '../src/browserAuth.ts';

test('proof exchanges use only same-origin POST bodies with current CSRF while account requests are paused', async () => {
  const original = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch };
  const base = 'https://merosplit.test', id = '01234567-89ab-cdef-0123-456789abcdef', proof = 'q'.repeat(64);
  Object.assign(globalThis, { window: { location: { origin: base } }, document: { cookie: 'csrftoken=current' } });
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return Response.json(String(url).endsWith('/renew') || String(url).endsWith('/request') ? { data: { accepted: true, retry_after: 60 } } : { meta: { is_authenticated: true }, data: { user: { id: 2, email: 'two@example.invalid' }, target: { kind: 'group', group_id: id }, needs_name: false } });
  };
  try {
    await pauseBrowserRequests();
    const result = await exchangeEmailLink(base, id, proof);
    assert.equal(result.session.userId, '2'); assert.equal(result.needsName, false);
    assert.deepEqual(result.target, { kind: 'group', group_id: id });
    await resumeEmailLink(base, id); await renewEmailLink(base, id); await requestEmailLink(base, 'two@example.invalid');
    for (const { url, init } of calls) {
      assert.ok(!url.includes(proof)); assert.equal(init.method, 'POST'); assert.equal(init.credentials, 'same-origin'); assert.equal(init.referrerPolicy, 'same-origin'); assert.equal(init.cache, 'no-store'); assert.equal(init.redirect, 'error');
      const headers = new Headers(init.headers); assert.equal(headers.get('X-CSRFToken'), 'current'); assert.equal(headers.get('X-MeroSplit-Account'), null); assert.equal(headers.get('X-Session-Token'), null);
    }
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), { grant_id: id, proof });
    assert.deepEqual(JSON.parse(String(calls[1].init.body)), { grant_id: id });
    await assert.rejects(exchangeEmailLink('https://another.invalid', id, proof)); assert.equal(calls.length, 4);
    globalThis.fetch = async () => Response.json({ data: { accepted: false, retry_after: 60 } });
    await assert.rejects(renewEmailLink(base, id), /Could not send/);
    globalThis.fetch = async () => new Response('Unavailable', { status: 503 });
    await assert.rejects(exchangeEmailLink(base, id, proof), /Could not connect/);
  } finally { resumeBrowserRequests(); Object.assign(globalThis, original); }
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const origin = 'https://merosplit.test', grantA = '01234567-89ab-cdef-0123-456789abcdef', grantB = '11234567-89ab-cdef-0123-456789abcdef';
const accepted = () => Response.json({ meta: { is_authenticated: true }, data: { user: { id: 2, email: 'two@example.invalid' }, target: { kind: 'home' }, needs_name: false } });
async function withBrowser(fetcher: typeof fetch, run: () => Promise<void>) {
  const original = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch };
  Object.assign(globalThis, { window: { location: { origin } }, document: { cookie: 'csrftoken=current' }, fetch: fetcher });
  try { await run(); } finally { Object.assign(globalThis, original); }
}

test('superseded pending resume does not exchange the old grant with a new link proof', async () => {
  const response = deferred<Response>(), calls: string[] = [];
  let current = true;
  await withBrowser(async url => { calls.push(String(url)); return response.promise; }, async () => {
    const link = { id: grantA, proof: 'a'.repeat(43) };
    const result = resolveEmailLink(origin, link, () => current);
    link.id = grantB; link.proof = 'b'.repeat(43); current = false;
    response.resolve(Response.json({}, { status: 401 }));
    assert.equal(await result, null);
    assert.equal(calls.length, 1); assert.ok(calls[0].endsWith('/resume'));
  });
});

test('captured grant and proof stay immutable across an awaited resume', async () => {
  const response = deferred<Response>(), bodies: unknown[] = [];
  await withBrowser(async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return bodies.length === 1 ? response.promise : accepted(); }, async () => {
    const link = { id: grantA, proof: 'a'.repeat(43) };
    const result = resolveEmailLink(origin, link, () => true);
    link.id = grantB; link.proof = 'b'.repeat(43);
    response.resolve(Response.json({}, { status: 401 }));
    assert.equal((await result)?.session.userId, '2');
    assert.deepEqual(bodies, [{ grant_id: grantA }, { grant_id: grantA, proof: 'a'.repeat(43) }]);
  });
});

test('late exchange acceptance is ignored after another link owns navigation', async () => {
  const exchange = deferred<Response>(), started = deferred<void>();
  let current = true, calls = 0;
  await withBrowser(async () => { calls++; if (calls === 1) return Response.json({}, { status: 401 }); started.resolve(); return exchange.promise; }, async () => {
    const result = resolveEmailLink(origin, { id: grantA, proof: 'a'.repeat(43) }, () => current);
    await started.promise; current = false; exchange.resolve(accepted());
    assert.equal(await result, null); assert.equal(calls, 2);
  });
});

test('unknown exchange response recovers the accepted cookie via resume without exchanging twice', async () => {
  const calls: string[] = [];
  await withBrowser(async url => {
    calls.push(String(url));
    if (calls.length === 1) return Response.json({}, { status: 401 });
    if (calls.length === 2) throw new TypeError('Synthetic lost response');
    return accepted();
  }, async () => {
    const result = await resolveEmailLink(origin, { id: grantA, proof: 'a'.repeat(43) }, () => true);
    assert.equal(result?.session.userId, '2');
    assert.deepEqual(calls.map(url => url.split('/').at(-1)), ['resume', 'exchange', 'resume']);
  });
});

test('failed recovery preserves the original exchange error and missing proof never exchanges', async () => {
  let calls = 0;
  await withBrowser(async () => { calls++; return Response.json({}, { status: calls === 2 ? 429 : 401 }); }, async () => {
    await assert.rejects(resolveEmailLink(origin, { id: grantA, proof: 'a'.repeat(43) }, () => true), error => error instanceof EmailLinkError && error.status === 429);
    assert.equal(calls, 3);
    calls = 0;
    await assert.rejects(resolveEmailLink(origin, { id: grantA, proof: null }, () => true), error => error instanceof EmailLinkError && error.status === 400);
    assert.equal(calls, 1);
    assert.equal(await resolveEmailLink(origin, { id: grantA, proof: 'a'.repeat(43) }, () => false), null);
    assert.equal(calls, 1);
  });
});
