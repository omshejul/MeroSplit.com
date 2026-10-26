import assert from 'node:assert/strict';
import test from 'node:test';
import worker from './worker.mjs';

const env = { FORWARD_TO: 'inbox@example.invalid' };

test('forwards the requested mailbox once to its configured destination', async () => {
  const forwarded = [];
  await worker.email({ to: 'mail@merosplit.com', forward: async to => forwarded.push(to) }, env);
  assert.deepEqual(forwarded, [env.FORWARD_TO]);
});

test('accepts address case without adding another route', async () => {
  const forwarded = [];
  await worker.email({ to: 'Mail@MeroSplit.com', forward: async to => forwarded.push(to) }, env);
  assert.deepEqual(forwarded, [env.FORWARD_TO]);
});

test('rejects other recipients without forwarding', async () => {
  for (const to of ['other@merosplit.com', 'mail@other.example', 'mail+tag@merosplit.com']) {
    const rejected = [];
    await worker.email({ to, setReject: reason => rejected.push(reason), forward: () => assert.fail('unexpected forward') }, env);
    assert.deepEqual(rejected, ['Unknown recipient']);
  }
});

test('leaves forwarding failures visible to the mail platform', async () => {
  const failure = new Error('synthetic delivery failure');
  await assert.rejects(worker.email({ to: 'mail@merosplit.com', forward: async () => { throw failure; } }, env), failure);
});

test('does not forward when the private destination is missing', async () => {
  await assert.rejects(worker.email({ to: 'mail@merosplit.com', forward: () => assert.fail('unexpected forward') }, {}), /not configured/);
});
