import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { APP_ORIGIN, parseNativeLink, startNativeLinks, type NativeLink, type NativeLinkSource } from '../src/appLinks.ts';

const group = '01234567-89ab-cdef-0123-456789abcdef', bill = '12345678-9abc-def0-1234-56789abcdef0';
const proof = 's'.repeat(64), emailURL = `${APP_ORIGIN}/app/sign-in/${group}#proof=${proof}`;
const groupURL = `${APP_ORIGIN}/app/groups/${group}`;
const token = `${group}:${'x'.repeat(43)}`;
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test('canonical email, group, bill and both existing invitation routes stay distinct', () => {
  assert.deepEqual(parseNativeLink(emailURL), { kind: 'email', link: { id: group, proof } });
  assert.deepEqual(parseNativeLink(`${APP_ORIGIN}/app/sign-in/${group}/`), { kind: 'email', link: { id: group, proof: null } });
  assert.deepEqual(parseNativeLink(groupURL), { kind: 'app', target: { groupId: group } });
  assert.deepEqual(parseNativeLink(`${groupURL}/bills/${bill.toUpperCase()}/`), { kind: 'app', target: { groupId: group, expenseId: bill } });
  for (const path of ['/invite/', '/app/invite/']) assert.deepEqual(parseNativeLink(`${APP_ORIGIN}${path}${encodeURIComponent(token)}`), { kind: 'app', target: { inviteToken: token } });
});

test('untrusted hosts, normalized escapes, private/public pages and malformed destinations do nothing', () => {
  const rejected = [null, '', emailURL.replace('https:', 'http:'), emailURL.replace('merosplit.', 'preview.merosplit.'),
    emailURL.replace('merosplit.omshejul.com', 'merosplit.omshejul.com.evil.test'),
    emailURL.replace('merosplit.omshejul.com', 'merosplit.omshejul.com@evil.test'),
    emailURL.replace('merosplit.omshejul.com', 'user@merosplit.omshejul.com'),
    emailURL.replace('merosplit.omshejul.com', 'merosplit.omshejul.com:443'),
    emailURL.replace('/app/', '/support/../app/'), emailURL.replace('/app/', '/%2e%2e/app/'),
    emailURL.replace('/app/', '/APP/'), `${emailURL}&next=other`, `${emailURL}?extra`, `${emailURL}/junk`, `${emailURL}\n`,
    `${APP_ORIGIN}/app/sign-in/bad#proof=${proof}`, `${APP_ORIGIN}/app/sign-in/${group}?next=/support#proof=${proof}`,
    `${APP_ORIGIN}/app/sign-in/${group}#proof=short`, `${groupURL}#proof=${proof}`, `${groupURL}?next=/support`,
    `${APP_ORIGIN}/app/`, `${APP_ORIGIN}/support`, `${APP_ORIGIN}/privacy`, `${APP_ORIGIN}/delete-account`,
    `${APP_ORIGIN}/app/media/${group}`, `${APP_ORIGIN}/api/v1/groups/${group}`, `${APP_ORIGIN}/_allauth/app/v1/auth/session`,
    `${groupURL}/members`, `${groupURL}/bills/bad`, `${APP_ORIGIN}/app/invite/%2Fprivate`, `${APP_ORIGIN}/invite/%`,
    `${APP_ORIGIN}/invite/%2e%2e`, `${APP_ORIGIN}/invite/%2E`, `${APP_ORIGIN}/invite/%5Cprivate`,
    `${APP_ORIGIN}/invite/${'x'.repeat(513)}`, `splitdumb://app/sign-in/${group}#proof=${proof}`,
    ...['upi', 'gpay', 'phonepe', 'paytmmp', 'credpay', 'bhim', 'amazonpay'].map(scheme => `${scheme}://pay?pa=synthetic@invalid`),
  ];
  for (const value of rejected) assert.equal(parseNativeLink(value), null, value?.replace(/#proof=.*/, '#proof=[redacted]'));
});

test('native parsing never depends on RN URL getters that can truncate a fragment', () => {
  const originalURL = globalThis.URL;
  Object.assign(globalThis, { URL: class { constructor() { throw new Error('RN URL parsing must not be used'); } } });
  try {
    assert.deepEqual(parseNativeLink(emailURL), { kind: 'email', link: { id: group, proof } });
    assert.equal(parseNativeLink(`${emailURL}/ignored-by-RN-hash`), null);
    assert.equal(parseNativeLink(`${APP_ORIGIN}/app/invite/%2e%2e`), null);
    assert.equal(parseNativeLink(`${APP_ORIGIN}/app/invite/${group}%2Fprivate`), null);
  } finally { Object.assign(globalThis, { URL: originalURL }); }
});

function source() {
  let resolve!: (value: string | null) => void, reject!: (error: Error) => void, callback: ((event: { url: string }) => void) | null = null;
  const initial = new Promise<string | null>((yes, no) => { resolve = yes; reject = no; });
  let removed = false;
  const linking: NativeLinkSource = {
    getInitialURL: () => initial,
    addEventListener: (_event, listener) => { callback = listener; return { remove: () => { removed = true; callback = null; } }; },
  };
  return { linking, resolve, reject, emit: (url: string) => callback?.({ url }), removed: () => removed };
}

test('cold lookup delivers parsed link before readiness and caller may retain it through hydration', async () => {
  const native = source(), events: string[] = [], pending: NativeLink[] = [];
  const stop = startNativeLinks(native.linking, value => { pending.push(value); events.push('link'); }, () => events.push('ready'));
  assert.deepEqual(events, []);
  native.resolve(emailURL); await tick();
  assert.deepEqual(events, ['link', 'ready']);
  assert.deepEqual(pending, [{ kind: 'email', link: { id: group, proof } }]);
  stop(); assert.equal(native.removed(), true);
});

test('valid warm event wins over late cold URL and simultaneous duplicate events coalesce', async () => {
  const native = source(), seen: NativeLink[] = [], ready: string[] = [];
  let finish!: () => void;
  const held = new Promise<void>(resolve => { finish = resolve; });
  const stop = startNativeLinks(native.linking, value => { seen.push(value); return held; }, () => ready.push('ready'));
  native.emit(emailURL); native.emit(emailURL); native.resolve(groupURL); await tick();
  assert.equal(seen.length, 1); assert.equal(seen[0].kind, 'email'); assert.deepEqual(ready, ['ready']);
  finish(); await tick();
  native.emit(emailURL); await tick();
  assert.equal(seen.length, 2, 'a later used-link tap can resume the correct session');
  stop();
});

test('business and email callbacks serialize without dropping a distinct queued destination', async () => {
  const native = source(), seen: NativeLink[] = [];
  let finish!: () => void;
  const stop = startNativeLinks(native.linking, value => { seen.push(value); if (seen.length === 1) return new Promise<void>(resolve => { finish = resolve; }); }, () => {});
  native.emit(emailURL); native.emit(groupURL); native.emit(groupURL); native.resolve(null); await tick();
  assert.equal(seen.length, 1);
  finish(); await tick();
  assert.deepEqual(seen[1], { kind: 'app', target: { groupId: group } }); assert.equal(seen.length, 2);
  stop();
});

test('UPI/untrusted warm events do not suppress cold app link and every lookup failure releases startup', async () => {
  const native = source(), seen: NativeLink[] = []; let ready = 0;
  const stop = startNativeLinks(native.linking, value => { seen.push(value); }, () => { ready++; });
  native.emit('upi://pay?tr=return'); native.emit('https://evil.test/app/sign-in/ignored'); native.resolve(groupURL); await tick();
  assert.deepEqual(seen, [{ kind: 'app', target: { groupId: group } }]); assert.equal(ready, 1); stop();
  const failed = source(); const stopFailed = startNativeLinks(failed.linking, () => assert.fail('no link'), () => { ready++; });
  failed.reject(new Error('native lookup unavailable')); await tick(); assert.equal(ready, 2); stopFailed();
  const empty = source(); const stopEmpty = startNativeLinks(empty.linking, () => assert.fail('no link'), () => { ready++; });
  empty.resolve(null); await tick(); assert.equal(ready, 3); stopEmpty();
});

test('unsubscribe drops queued proofs and ignores delayed cold resolution', async () => {
  const native = source(), seen: NativeLink[] = []; let ready = false, finish!: () => void;
  const stop = startNativeLinks(native.linking, value => { seen.push(value); return new Promise<void>(resolve => { finish = resolve; }); }, () => { ready = true; });
  native.emit(groupURL); native.emit(emailURL); stop(); native.resolve(emailURL); finish(); await tick();
  assert.equal(seen.length, 1); assert.equal(ready, false); assert.equal(native.removed(), true);
});

test('Expo associations stay on exact canonical HTTPS routes, preserving custom and seven UPI schemes', () => {
  const { expo } = JSON.parse(readFileSync(new URL('../app.json', import.meta.url), 'utf8'));
  assert.deepEqual(expo.ios.associatedDomains, ['applinks:merosplit.omshejul.com']);
  assert.deepEqual(expo.android.intentFilters, [{ action: 'VIEW', autoVerify: true, category: ['BROWSABLE', 'DEFAULT'], data: ['/app/sign-in/', '/app/groups/', '/app/invite/', '/invite/'].map(pathPrefix => ({ scheme: 'https', host: 'merosplit.omshejul.com', pathPrefix })) }]);
  assert.equal(expo.scheme, 'splitdumb'); assert.equal(expo.version, '0.3.10'); assert.equal(expo.ios.buildNumber, '18'); assert.equal(expo.android.versionCode, 18);
  assert.deepEqual(expo.ios.infoPlist.LSApplicationQueriesSchemes, ['upi', 'gpay', 'phonepe', 'paytmmp', 'credpay', 'bhim', 'amazonpay']);
});
