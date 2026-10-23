import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../plugins/with-upi.cjs', import.meta.url), 'utf8');
type Query = { intent?: { action: { $: { 'android:name': string } }[]; data: { $: Record<string, string> }[] }[] };
type Manifest = { queries?: Query[]; [key: string]: unknown };
function configure(manifest: Manifest): Manifest {
  const module = { exports: null as unknown };
  vm.runInNewContext(source, { module, require: (name: string) => {
    assert.equal(name, 'expo/config-plugins');
    return { withAndroidManifest: (config: unknown, action: (config: unknown) => unknown) => action(config) };
  } });
  // Execute the production plugin callback; only Expo's mod registration is
  // replaced. No native project, manifest file or build is generated.
  const plugin = module.exports as (config: { modResults: { manifest: Manifest } }) => { modResults: { manifest: Manifest } };
  return JSON.parse(JSON.stringify(plugin({ modResults: { manifest } }).modResults.manifest)) as Manifest;
}
const view = 'android.intent.action.VIEW';
const query = (scheme: string, host?: string): Query => ({ intent: [{ action: [{ $: { 'android:name': view } }], data: [{ $: { 'android:scheme': scheme, ...(host ? { 'android:host': host } : {}) } }] }] });
const paymentQuery = query('upi', 'pay');

test('Android UPI query exposes the actual upi://pay handler contract and is idempotent', () => {
  const result = configure({ application: [{ $: { 'android:label': 'MeroSplit' } }] });
  assert.deepEqual(result.queries, [paymentQuery]);
  assert.deepEqual(configure(result), result);
  assert.deepEqual(result.application, [{ $: { 'android:label': 'MeroSplit' } }]);
  assert.equal(JSON.stringify(result).includes('QUERY_ALL_PACKAGES'), false);
});

test('existing scheme-only queries are upgraded additively without changing app-specific visibility or permissions', () => {
  const originalQueries = [query('upi'), ...['gpay', 'phonepe', 'paytmmp', 'credpay', 'bhim', 'amazonpay'].map(scheme => query(scheme))];
  const permissions = [{ $: { 'android:name': 'android.permission.INTERNET' } }];
  const result = configure({ queries: structuredClone(originalQueries), 'uses-permission': permissions });
  assert.deepEqual(result.queries, [...originalQueries, paymentQuery]);
  assert.deepEqual(result['uses-permission'], permissions);
  assert.deepEqual(configure(result), result);
});

test('a different host or unrelated data entry never satisfies the payment visibility query', () => {
  const other = query('upi', 'other');
  other.intent![0].data.push({ $: { 'android:scheme': 'custom', 'android:host': 'pay' } });
  const result = configure({ queries: [other] });
  assert.deepEqual(result.queries, [other, paymentQuery]);
});
