import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

function harness(os: string) {
  const slots: any[] = [], animations: any[] = []; let cursor = 0, enabled = true;
  const React = { createElement: (type: unknown, props: any, ...children: unknown[]) => ({ type, props, children }),
    useRef: (initial: unknown) => slots[cursor++] ??= { current: initial },
    useLayoutEffect(run: () => any, deps: unknown[]) {
      const i = cursor++, before = slots[i];
      if (!before || deps.some((value, n) => value !== before.deps[n])) { before?.cleanup?.(); slots[i] = { deps, cleanup: run() }; }
    },
  };
  class Value { value: number; constructor(value: number) { this.value = value; } setValue(value: number) { this.value = value; } interpolate(config: any) { return { value: this.value, ...config }; } }
  const modules: any = { react: React, './ui': { useUI: () => ({ motion: { enabled } }) }, 'react-native': { Platform: { OS: os }, Easing: { out: (v: any) => v, cubic: 'cubic' }, Animated: { Value, View: 'Animated.View', timing: (value: Value, options: any) => { const animation = { value, options, stopped: false, start() {}, stop() { this.stopped = true; } }; animations.push(animation); return animation; } } } };
  const exports: any = {};
  const code = ts.transpile(readFileSync(new URL('../src/StaggerItem.tsx', import.meta.url), 'utf8'), { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React });
  new Function('require', 'exports', code)((name: string) => modules[name], exports);
  return { animations, render(entry?: { delay: number; played: boolean }, motion = enabled) { cursor = 0; enabled = motion; return exports.default({ entry, children: 'pressable row' }); }, cleanup() { slots.forEach(s => s?.cleanup?.()); }, exports };
}
for (const os of ['ios', 'android', 'web']) {
  test(`${os}: a transaction waits until visible, staggers once and survives recycling`, () => {
    const h = harness(os); h.render(); assert.equal(h.animations.length, 0, 'offscreen rows do not spend their entrance');
    const entry = { delay: 70, played: false }, row = h.render(entry);
    assert.equal(h.animations.length, 1); assert.equal(entry.played, true);
    const options = h.animations[0].options;
    assert.equal(options.delay, 70); assert.equal(options.duration, 260);
    assert.equal(options.useNativeDriver, os !== 'web'); assert.equal(options.isInteraction, false);
    assert.deepEqual(row.props.style.opacity.outputRange, [0.35, 1]); assert.deepEqual(row.props.style.transform[0].translateY.outputRange, [12, 0]);
    h.render(entry); assert.equal(h.animations.length, 1, 'refresh does not replay');
    h.cleanup(); const recycled = harness(os); recycled.render(entry); assert.equal(recycled.animations.length, 0, 'a recycled row stays still');
    assert.equal(row.props.pointerEvents, undefined);
  });
  test(`${os}: reduced motion and resume never replay an entered transaction`, () => {
    const entry = { delay: 0, played: false }, reduced = harness(os);
    reduced.render(entry, false); reduced.render(entry, true); assert.equal(reduced.animations.length, 0);
    const h = harness(os), later = { delay: 0, played: false }; h.render(later); h.render(later, false); h.render(later, true);
    assert.equal(h.animations.length, 1); assert.equal(h.animations[0].value.value, 1); assert.equal(h.animations[0].stopped, true);
  });
}
