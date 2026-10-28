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
  return { animations, render(index: number, motion = enabled) { cursor = 0; enabled = motion; return exports.default({ index, children: 'pressable row' }); }, cleanup() { slots.forEach(s => s?.cleanup?.()); }, exports };
}
for (const os of ['ios', 'android', 'web']) {
  test(`${os}: rows stagger once, remain visible and do not block interaction`, () => {
    const h = harness(os), row = h.render(3);
    assert.equal(h.animations.length, 1); assert.equal(h.animations[0].options.delay, 90);
    assert.equal(h.animations[0].options.duration, 180); assert.equal(h.animations[0].options.useNativeDriver, os !== 'web'); assert.equal(h.animations[0].options.isInteraction, false);
    assert.deepEqual(row.props.style.opacity.outputRange, [0.88, 1]); assert.deepEqual(row.props.style.transform[0].translateY.outputRange, [8, 0]);
    assert.equal(row.props.pointerEvents, undefined); assert.equal(row.props.accessible, undefined);
    h.render(4); assert.equal(h.animations.length, 1, 'reordering cannot replay entry');
    h.render(4, false); h.render(4, true); assert.equal(h.animations.length, 1, 'resume cannot replay entry'); assert.equal(h.animations[0].value.value, 1);
    h.cleanup(); assert.equal(h.animations[0].stopped, true);
  });
  test(`${os}: reduced motion and later virtualized rows stay still`, () => {
    const reduced = harness(os); reduced.render(0, false); reduced.render(0, true); assert.equal(reduced.animations.length, 0);
    for (const index of [8, 10000]) { const later = harness(os); later.render(index); assert.equal(later.animations.length, 0); }
    const last = harness(os); last.render(7); assert.equal(last.animations[0].options.delay, 210);
  });
}
