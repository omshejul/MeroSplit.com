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


test('directory follows verified NPCI app-volume order then alphabetical unranked apps', () => {
  assert.deepEqual(upiDirectory.slice(0, 7).map(app => app.name), ['PhonePe', 'Google Pay', 'Paytm', 'Navi', 'super.money', 'CRED', 'FamApp by Trio']);
  const unranked = upiDirectory.slice(7).map(app => app.name);
  assert.deepEqual(unranked, [...unranked].sort((a, b) => a.toLowerCase() < b.toLowerCase() ? -1 : 1));
  assert.equal(upiDirectory.length, 23);
});
