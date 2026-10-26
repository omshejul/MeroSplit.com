import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from '../src/api.ts';
import { recordConnection, serverReachable, subscribeConnection } from '../src/connectivity.ts';
import type { Session } from '../src/types.ts';
const session: Session = { baseUrl: 'https://request.test', userId: '1', email: 'one@example.test', token: 'synthetic' };

test('caller cancellation keeps connectivity stable, including cancellation before fetch', async () => {
  const original = globalThis.fetch, transitions: boolean[] = [];
  recordConnection(true);
  const unsubscribe = subscribeConnection(() => transitions.push(serverReachable()));
  globalThis.fetch = async (_url, init) => new Promise((_resolve, reject) => {
    const abort = () => reject(new DOMException('Cancelled', 'AbortError'));
    if (init?.signal?.aborted) abort(); else init?.signal?.addEventListener('abort', abort, { once: true });
  });
  try {
    for (const before of [false, true]) {
      const controller = new AbortController(); if (before) controller.abort();
      const result = request(session, '/expense-icons?ids=one', 'GET', undefined, 'json', controller.signal);
      controller.abort();
      await assert.rejects(result, { name: 'AbortError' });
      assert.equal(serverReachable(), true);
    }
    assert.deepEqual(transitions, []);
  } finally { unsubscribe(); globalThis.fetch = original; recordConnection(true); }
});

test('network failure and internal timeout still mark the server unreachable', async t => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => { throw new TypeError('Network failed'); };
    recordConnection(true);
    await assert.rejects(request(session, '/me'), /Could not connect/);
    assert.equal(serverReachable(), false);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    globalThis.fetch = async (_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('Timed out', 'AbortError')), { once: true }));
    recordConnection(true);
    const result = request(session, '/me'); t.mock.timers.tick(15_000);
    await assert.rejects(result, /Could not connect/);
    assert.equal(serverReachable(), false);
  } finally { t.mock.timers.reset(); globalThis.fetch = original; recordConnection(true); }
});
