import test from 'node:test';
import assert from 'node:assert/strict';
import { captureEmailLink, emailTarget, forgetEmailProof, parseEmailLink, subscribeEmailLinks } from '../src/emailLink.ts';

const id = '01234567-89ab-cdef-0123-456789abcdef', proof = 's'.repeat(64);
test('email destinations are closed account routes and cannot redirect to arbitrary URLs', () => {
  assert.deepEqual(emailTarget({ kind: 'home' }), { kind: 'home' });
  assert.deepEqual(emailTarget({ kind: 'group', group_id: id }), { kind: 'group', group_id: id });
  for (const value of [null, 'https://other.invalid', { kind: 'redirect', url: 'https://other.invalid' }, { kind: 'group', group_id: '../account' }]) assert.throws(() => emailTarget(value), /not available/);
});
test('link parsing keeps recipient proof separate from ordinary invitation and bank links', () => {
  assert.deepEqual(parseEmailLink(`/app/sign-in/${id}`, `#proof=${proof}`), { id, proof });
  assert.equal(parseEmailLink('/app/invite/manual-capability', '#proof=wrong'), null);
  assert.equal(parseEmailLink('upi://pay', '#proof=wrong'), null);
  assert.deepEqual(parseEmailLink(`/app/sign-in/${id}`, `#proof=${proof}&next=other`), { id, proof: null });
});
test('cold bootstrap and duplicate warm events retain only in-memory proof and scrub immediately', () => {
  const originalWindow = globalThis.window;
  const listeners = new Map<string, () => void>(), writes: string[] = [];
  const browser = { __meroSplitEmailLink: { id, proof }, location: { pathname: `/app/sign-in/${id}`, hash: '', search: '' }, history: { replaceState: (_state: unknown, _title: string, path: string) => { writes.push(path); browser.location.hash = ''; } }, addEventListener: (name: string, callback: () => void) => listeners.set(name, callback), removeEventListener: (name: string) => listeners.delete(name) };
  Object.assign(globalThis, { window: browser }); forgetEmailProof();
  try {
    assert.deepEqual(captureEmailLink(), { id, proof });
    assert.equal('__meroSplitEmailLink' in browser, false);
    assert.deepEqual(captureEmailLink(), { id, proof });
    const seen: unknown[] = [], unsubscribe = subscribeEmailLinks(value => seen.push(value));
    browser.location.hash = `#proof=${proof}`;
    listeners.get('hashchange')!(); listeners.get('popstate')!();
    assert.equal(browser.location.hash, '');
    assert.deepEqual(seen, [{ id, proof }, { id, proof }]);
    assert.ok(writes.every(path => !path.includes(proof)));
    forgetEmailProof(); assert.deepEqual(captureEmailLink(), { id, proof: null });
    unsubscribe(); assert.equal(listeners.size, 0);
  } finally { forgetEmailProof(); Object.assign(globalThis, { window: originalWindow }); }
});
