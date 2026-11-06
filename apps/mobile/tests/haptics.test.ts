import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

function webFeedback({ coarse = true, visible = true, unavailable = false, reject = false, server = false } = {}) {
  let instances = 0;
  const patterns: string[] = [], options: unknown[] = [];
  class WebHaptics {
    constructor(config: unknown) { instances++; options.push(config); if (unavailable) throw Error('Unavailable'); }
    trigger(pattern: string) { patterns.push(pattern); return reject ? Promise.reject(Error('Blocked')) : Promise.resolve(); }
  }
  const source = readFileSync(new URL('../src/haptics.web.ts', import.meta.url), 'utf8').replace(/^import .*;\n/m, '').replace('export function', 'function');
  const window = server ? undefined : { matchMedia: (query: string) => { assert.equal(query, '(any-pointer: coarse)'); return { matches: coarse }; } };
  const document = server ? undefined : { visibilityState: visible ? 'visible' : 'hidden' };
  const tap = new Function('WebHaptics', 'window', 'document', ts.transpile(source, { target: ts.ScriptTarget.ES2022 }) + '\nreturn tapHaptic;')(WebHaptics, window, document);
  return { tap, patterns, options, instances: () => instances };
}

test('web touch feedback lazily reuses one silent selection engine', () => {
  const feedback = webFeedback(); assert.equal(feedback.instances(), 0);
  feedback.tap(); feedback.tap();
  assert.deepEqual(feedback.patterns, ['selection', 'selection']);
  assert.equal(feedback.instances(), 1);
  assert.deepEqual(feedback.options, [{ debug: false, showSwitch: false }]);
});

test('server, desktop and hidden pages have no feedback side effects', () => {
  for (const settings of [{ coarse: false }, { visible: false }, { server: true }]) {
    const feedback = webFeedback(settings); feedback.tap(); assert.equal(feedback.instances(), 0);
  }
});

test('unavailable or rejected haptics never throw into the action', async () => {
  for (const settings of [{ unavailable: true }, { reject: true }]) {
    const feedback = webFeedback(settings); assert.doesNotThrow(() => feedback.tap());
    await Promise.resolve();
  }
});


test('native feedback selects the platform API and ignores unsupported hardware errors', async () => {
  const source = readFileSync(new URL('../src/haptics.ts', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '').replace('export function', 'function');
  for (const platform of ['android', 'ios']) for (const reject of [false, true]) {
    const calls: string[] = [];
    const response = () => reject ? Promise.reject(Error('No haptics')) : Promise.resolve();
    const Haptics = { AndroidHaptics: { Virtual_Key: 'virtual-key' }, performAndroidHapticsAsync: (type: string) => { calls.push(type); return response(); }, selectionAsync: () => { calls.push('selection'); return response(); } };
    const tap = new Function('Platform', 'Haptics', ts.transpile(source, { target: ts.ScriptTarget.ES2022 }) + '\nreturn tapHaptic;')({ OS: platform }, Haptics);
    assert.doesNotThrow(() => tap()); await Promise.resolve();
    assert.deepEqual(calls, [platform === 'android' ? 'virtual-key' : 'selection']);
  }
});
