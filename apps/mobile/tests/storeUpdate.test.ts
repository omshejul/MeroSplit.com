import test from 'node:test';
import assert from 'node:assert/strict';
import { appStores, checkStoreUpdate } from '../src/storeUpdate.ts';

async function withRelease(value: unknown, work: (calls: any[]) => Promise<void>, status = 200) {
 const original = globalThis.fetch, calls: any[] = [];
 globalThis.fetch = (async (...args: any[]) => { calls.push(args); return new Response(JSON.stringify(value), { status }); }) as typeof fetch;
 try { await work(calls); } finally { globalThis.fetch = original; }
}
test('store checks compare installed builds within the same version', async () => {
 await withRelease({ ios: { version: '1.2.4', build: '32' }, android: { version: '1.2.3', build: '33' } }, async calls => {
  assert.equal(await checkStoreUpdate('https://merosplit.com/', 'ios', '31', '1.2.4'), '1.2.4:32');
  assert.equal(await checkStoreUpdate('https://merosplit.com', 'ios', '32', '1.2.4'), null);
  assert.equal(await checkStoreUpdate('https://merosplit.com', 'android', '34', '1.2.3'), null);
  assert.equal(calls[0][0], 'https://merosplit.com/api/v1/app-releases');
  assert.equal(calls[0][1].credentials, 'omit'); assert.equal(calls[0][1].cache, 'no-store');
  assert.equal(calls[0][1].headers, undefined);
 });
});
test('new versions are detected with reused or lower build numbers and numeric version ordering', async () => {
 for (const [installedVersion, installedBuild, version, build, expected] of [
  ['1.2.4','35','1.2.5','35','1.2.5:35'],
  ['1.2.4','35','1.2.5','1','1.2.5:1'],
  ['1.2.9','35','1.2.10','35','1.2.10:35'],
  ['1.10','35','1.2.100','99',null],
  ['1.2','34','1.2.0','35','1.2.0:35'],
  ['1.2.5','35','1.2.4','36',null],
 ]) await withRelease({ios:{version,build}},async()=>assert.equal(await checkStoreUpdate('https://merosplit.com','ios',installedBuild,installedVersion),expected));
});
test('missing, malformed and failed store checks never claim that the app is current', async () => {
 for (const response of [{}, {ios:{version:'1.2.4',build:32}}, {ios:{version:'1.2.4',build:'32.0'}}, {ios:{version:'1.2.4',build:'-1'}}, {ios:{version:'1.2.4',build:'1e3'}}, {ios:{build:'32'}}, {ios:{version:'1.2.beta',build:'32'}}]) {
  await withRelease(response, async () => assert.rejects(checkStoreUpdate('https://merosplit.com','ios','31','1.2.4')));
 }
 await withRelease({}, async () => assert.rejects(checkStoreUpdate('https://merosplit.com','ios','31','1.2.4')), 503);
 for (const build of [undefined, null, '0', '-1', '31.2', '']) await assert.rejects(checkStoreUpdate('https://merosplit.com','ios',build,'1.2.4'));
 for (const version of [undefined,null,'','1.beta',1.2]) await assert.rejects(checkStoreUpdate('https://merosplit.com','ios','31',version));
 await assert.rejects(checkStoreUpdate('https://merosplit.com','web','31','1.2.4'));
 assert.ok(appStores.ios.web.endsWith('id6823916128'));
 assert.ok(appStores.android.web.endsWith('id=com.omshejul.splitdumb'));
});
