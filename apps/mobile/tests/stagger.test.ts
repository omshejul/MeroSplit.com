import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

function harness(os: string) {
  const slots: any[] = [], animations: any[] = [], sequences: any[] = []; let cursor = 0, enabled = true;
  const React = { createElement: (type: unknown, props: any, ...children: unknown[]) => ({ type, props, children }),
    useRef: (initial: unknown) => slots[cursor++] ??= { current: initial },
    useLayoutEffect(run: () => any, deps: unknown[]) {
      const i = cursor++, before = slots[i];
      if (!before || deps.some((value, n) => value !== before.deps[n])) { before?.cleanup?.(); slots[i] = { deps, cleanup: run() }; }
    },
  };
  class Value { value: number; constructor(value: number) { this.value = value; } setValue(value: number) { this.value = value; } interpolate(config: any) { return { value: this.value, ...config }; } }
  const modules: any = { react: React, './motionShared': { transactionLiftTiming: { rise: 170, hold: 280, return: 300 } }, './ui': { useUI: () => ({ motion: { enabled } }) }, 'react-native': { Platform: { OS: os }, Easing: { out: (v: any) => v, cubic: 'cubic', bezier: (...points: number[]) => points }, Animated: { Value, delay: (duration: number) => ({ duration }), sequence: (steps: any[]) => { const sequence = { steps, start() {}, stop() {} }; sequences.push(sequence); return sequence; }, View: 'Animated.View', timing: (value: Value, options: any) => { const animation = { value, options, stopped: false, start() {}, stop() { this.stopped = true; } }; animations.push(animation); return animation; } } } };
  const exports: any = {};
  const code = ts.transpile(readFileSync(new URL('../src/StaggerItem.tsx', import.meta.url), 'utf8'), { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React });
  new Function('require', 'exports', code)((name: string) => modules[name], exports);
  return { animations, sequences, render(entry?: { delay: number; played: boolean }, motion = enabled, lifted = false) { cursor = 0; enabled = motion; return exports.default({ entry, lifted, children: 'pressable row' }); }, cleanup() { slots.forEach(s => s?.cleanup?.()); }, exports };
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

test('a settled reveal uses the Soft landing curves and reduced motion skips the lift', () => {
  const h = harness('web');
  h.render();
  assert.equal(h.sequences.length, 0);
  h.render(undefined, true, true);
  const [rise, hold, settle] = h.sequences[0].steps;
  assert.deepEqual([rise.options.toValue, rise.options.duration, rise.options.easing], [-2, 170, [0.22, 0.61, 0.36, 1]]);
  assert.equal(hold.duration, 280);
  assert.deepEqual([settle.options.toValue, settle.options.duration, settle.options.easing], [0, 300, [0.32, 0, 0.28, 1]]);
  h.render(undefined, false, true);
  assert.equal(h.sequences.length, 1);
});
