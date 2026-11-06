import assert from 'node:assert/strict';
import test from 'node:test';
import { scrubSentryEvent } from '../src/sentryPrivacy.ts';

test('diagnostics remove content and credentials but retain stack locations', () => {
  const event = {
    request: { url: 'https://example.test/j/private-token', headers: { Authorization: 'secret' } },
    user: { email: 'private@example.test' },
    extra: { bill: 'Private bill' }, breadcrumbs: [{ message: 'Private note' }],
    message: 'Private message', transaction: '/j/private-token',
    exception: { values: [{ type: 'TypeError', value: 'Private bill', stacktrace: {
      frames: [{ filename: 'App.tsx', lineno: 42, vars: { token: 'secret' }, context_line: 'private' }],
    } }] },
  };
  const result = scrubSentryEvent(event);
  const payload = JSON.stringify(result);
  for (const value of ['private-token', 'secret', 'Private', 'private@example', 'context_line']) {
    assert.equal(payload.includes(value), false);
  }
  assert.equal(result.exception.values[0].type, 'TypeError');
  assert.equal(result.exception.values[0].stacktrace.frames[0].lineno, 42);
});
