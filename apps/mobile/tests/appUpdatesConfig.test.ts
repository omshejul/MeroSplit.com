import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const config = JSON.parse(readFileSync(new URL('../app.json', import.meta.url), 'utf8')).expo;
const eas = JSON.parse(readFileSync(new URL('../eas.json', import.meta.url), 'utf8'));

test('native OTA checks are nonblocking on launch, retain embedded offline startup and fingerprint compatibility', () => {
  assert.equal(config.updates.checkAutomatically, 'ON_LOAD');
  assert.equal(config.updates.fallbackToCacheTimeout, 0);
  assert.notEqual(config.updates.enabled, false);
  assert.notEqual(config.updates.useEmbeddedUpdate, false);
  assert.notEqual(config.updates.disableAntiBrickingMeasures, true);
  assert.deepEqual(config.runtimeVersion, { policy: 'fingerprint' });
  assert.equal(config.extra.eas.projectId, '7b058184-31a7-41e9-96e1-5a752b7bf14f');
  assert.equal(config.updates.url, `https://u.expo.dev/${config.extra.eas.projectId}`);
});

test('local native builds and both EAS release profiles target the same production channel', () => {
  assert.equal(config.updates.requestHeaders['expo-channel-name'], 'merosplit-production');
  assert.equal(eas.build.beta.channel, 'merosplit-production');
  assert.equal(eas.build.production.channel, 'merosplit-production');
  assert.equal(eas.build.production.extends, 'beta');
  assert.equal(eas.build.beta.environment, 'production');
});


test('browser startup exports every update control rendered by App', async () => {
  const ts = await import('typescript');
  const source = readFileSync(new URL('../src/AppUpdates.web.tsx', import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
  const browser = await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));
  assert.equal(typeof browser.default, 'function');
  assert.equal(typeof browser.AppUpdatePrompt, 'function');
  assert.equal(browser.default({ update: {} }), null);
  assert.equal(browser.AppUpdatePrompt({ update: {} }), null);
});
