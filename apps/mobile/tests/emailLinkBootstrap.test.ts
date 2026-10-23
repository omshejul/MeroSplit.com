import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../scripts/email-link-bootstrap.js', import.meta.url), 'utf8');
const id = '01234567-89ab-cdef-0123-456789abcdef', proof = 'p'.repeat(64);
function run(pathname: string, hash: string) {
  const window: Record<string, unknown> = {}, writes: string[] = [];
  vm.runInNewContext(source, { window, location: { pathname, hash }, history: { replaceState: (_state: unknown, _title: string, path: string) => writes.push(path) } });
  return { value: JSON.parse(JSON.stringify(window.__meroSplitEmailLink ?? null)), writes };
}
test('real bootstrap captures a fragment in memory and synchronously removes it from history', () => {
  const result = run(`/app/sign-in/${id}`, `#proof=${proof}`);
  assert.deepEqual(result.value, { id, proof });
  assert.deepEqual(result.writes, [`/app/sign-in/${id}`]);
  assert.ok(!result.writes.join('').includes(proof));
});
test('malformed, missing and duplicate proof fragments never become usable credentials', () => {
  for (const hash of ['', '#proof=short', `#proof=${proof}&proof=${proof}`, `#proof=${proof}&target=https://other.invalid`]) {
    assert.deepEqual(run(`/app/sign-in/${id}`, hash), { value: { id, proof: null }, writes: [`/app/sign-in/${id}`] });
  }
  assert.deepEqual(run('/app/sign-in/invalid', `#proof=${proof}`), { value: { id: null, proof }, writes: ['/app/sign-in/'] });
});
test('ordinary group and UPI-return navigation is untouched', () => {
  assert.deepEqual(run(`/app/groups/${id}`, '#other'), { value: null, writes: [] });
});
