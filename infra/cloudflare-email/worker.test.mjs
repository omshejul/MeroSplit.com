import assert from 'node:assert/strict';
import test from 'node:test';
import worker from './worker.mjs';

test('forwards the requested mailbox once to its fixed destination', async () => {
  const forwarded = [];
  await worker.email({ to: 'mail@merosplit.com', forward: async to => forwarded.push(to) });
  assert.deepEqual(forwarded, ['mail@merosplit.com']);
});

test('accepts address case without adding another route', async () => {
  const forwarded = [];
  await worker.email({ to: 'Mail@MeroSplit.com', forward: async to => forwarded.push(to) });
  assert.deepEqual(forwarded, ['mail@merosplit.com']);
});

test('rejects other recipients without forwarding', async () => {
  for (const to of ['other@merosplit.com', 'mail@other.example', 'mail+tag@merosplit.com']) {
    const rejected = [];
    await worker.email({ to, setReject: reason => rejected.push(reason), forward: () => assert.fail('unexpected forward') });
    assert.deepEqual(rejected, ['Unknown recipient']);
  }
});

test('leaves forwarding failures visible to the mail platform', async () => {
  const failure = new Error('synthetic delivery failure');
  await assert.rejects(worker.email({ to: 'mail@merosplit.com', forward: async () => { throw failure; } }), failure);
});
