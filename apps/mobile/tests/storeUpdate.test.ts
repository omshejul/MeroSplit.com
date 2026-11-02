import test from 'node:test';
import assert from 'node:assert/strict';
import { appStores, checkStoreUpdate } from '../src/storeUpdate.ts';

async function withRelease(value: unknown, work: (calls: any[]) => Promise<void>, status = 200) {
 const original = globalThis.fetch, calls: any[] = [];
 globalThis.fetch = (async (...args: any[]) => { calls.push(args); return new Response(JSON.stringify(value), { status }); }) as typeof fetch;
 try { await work(calls); } finally { globalThis.fetch = original; }
}
test('store checks compare installed build numbers, including newer, equal and ahead binaries', async () => {
 await withRelease({ ios: { build: '32' }, android: { build: '33' } }, async calls => {
  assert.equal(await checkStoreUpdate('https://merosplit.com/', 'ios', '31'), true);
  assert.equal(await checkStoreUpdate('https://merosplit.com', 'ios', '32'), false);
  assert.equal(await checkStoreUpdate('https://merosplit.com', 'android', '34'), false);
  assert.equal(calls[0][0], 'https://merosplit.com/api/v1/app-releases');
  assert.equal(calls[0][1].credentials, 'omit'); assert.equal(calls[0][1].cache, 'no-store');
  assert.equal(calls[0][1].headers, undefined);
 });
});
test('missing, malformed and failed store checks never claim that the app is current', async () => {
 for (const response of [{}, {ios:{build:32}}, {ios:{build:'32.0'}}, {ios:{build:'-1'}}, {ios:{build:'1e3'}}]) {
  await withRelease(response, async () => assert.rejects(checkStoreUpdate('https://merosplit.com','ios','31')));
 }
 await withRelease({}, async () => assert.rejects(checkStoreUpdate('https://merosplit.com','ios','31')), 503);
 for (const build of [undefined, null, '0', '-1', '31.2', '']) await assert.rejects(checkStoreUpdate('https://merosplit.com','ios',build));
 await assert.rejects(checkStoreUpdate('https://merosplit.com','web','31'));
 assert.ok(appStores.ios.web.endsWith('id6823916128'));
 assert.ok(appStores.android.web.endsWith('id=com.omshejul.splitdumb'));
});
