import test from 'node:test';
import assert from 'node:assert/strict';
import { upiDirectory, upiDirectoryLink } from '../src/upiDirectory.ts';

test('UPI discovery uses official HTTPS links and never a payment URI or other platform store', () => {
  assert.equal(new Set(upiDirectory.map(app => app.name)).size, upiDirectory.length);
  for (const app of upiDirectory) {
    for (const platform of ['ios', 'android', 'web']) {
      const link = upiDirectoryLink(app, platform);
      assert.equal(new URL(link.url).protocol, 'https:');
      if (link.label === 'App Store') assert.equal(platform, 'ios');
      if (link.label === 'Google Play') assert.equal(platform, 'android');
    }
    assert.equal(upiDirectoryLink(app, 'web').url, app.website);
  }
});
