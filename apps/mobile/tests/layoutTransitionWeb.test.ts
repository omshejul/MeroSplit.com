import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../src/layoutTransition.web.ts', import.meta.url), 'utf8');
function harness() {
  const frames = new Map<number, () => void>();
  let sequence = 0, listener: (event: { matches: boolean }) => void = () => {};
  const preference = { matches: false, addEventListener: (_: string, value: typeof listener) => { listener = value; } };
  const nodes: ReturnType<typeof node>[] = [];
  function node(top: number, opacity = '1', transform = 'none') {
    const value = {
      top, style: { opacity, transform }, isConnected: true, parentElement: { closest: () => null },
      effect: null as null | { offset: number; opacity?: string },
      animations: [] as { keyframes: Keyframe[]; cancelled: boolean; onfinish: null | (() => void); cancel: () => void }[],
      getBoundingClientRect: () => ({ left: 0, top: value.top + (value.effect?.offset ?? 0) }),
      animate: (keyframes: Keyframe[]) => {
        const animation = { keyframes, cancelled: false, onfinish: null as null | (() => void), cancel: () => { animation.cancelled = true; value.effect = null; } };
        value.animations.push(animation);
        return animation;
      },
    };
    return value;
  }
  const scope = { querySelectorAll: () => nodes };
  const exports: { animateLayout?: (enabled: boolean) => void } = {};
  runInNewContext(ts.transpile(source, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }), {
    exports, document: { querySelectorAll: () => [scope], querySelector: () => scope },
    window: { matchMedia: () => preference },
    getComputedStyle: (value: ReturnType<typeof node>) => ({ ...value.style, opacity: value.effect?.opacity ?? value.style.opacity }),
    requestAnimationFrame: (callback: () => void) => { const id = ++sequence; frames.set(id, callback); return id; },
    cancelAnimationFrame: (id: number) => frames.delete(id),
  });
  return { node, nodes, frames, animateLayout: exports.animateLayout!,
    frame: () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback()); },
    reduce: () => { preference.matches = true; listener({ matches: true }); },
  };
}

test('rapid web layout changes continue from the visible position and clean up their own effects', () => {
  const h = harness(), person = h.node(100, '1', 'scale(0.98)'); h.nodes.push(person);
  h.animateLayout(true); h.animateLayout(true); assert.equal(h.frames.size, 1);
  person.top = 150; h.frame();
  const first = person.animations[0]; assert.equal(first.keyframes[0].transform, 'translate(0px, -50px) scale(0.98)');
  person.effect = { offset: -25 }; // Halfway through the first transition: visible y=125.
  h.animateLayout(true); assert.equal(first.cancelled, true);
  person.top = 200; h.frame();
  const second = person.animations[1]; assert.equal(second.keyframes[0].transform, 'translate(0px, -75px) scale(0.98)');
  assert.equal(second.keyframes[1].transform, 'scale(0.98)');
  second.onfinish!(); assert.equal(second.cancelled, true);
  assert.deepEqual(person.style, { opacity: '1', transform: 'scale(0.98)' });
});

test('new controls fade to their intended opacity and preserve inline styles', () => {
  const h = harness(); h.animateLayout(true);
  const disabled = h.node(150, '0.4', 'scale(0.9)'); h.nodes.push(disabled); h.frame();
  const animation = disabled.animations[0];
  assert.equal(animation.keyframes[0].opacity, 0); assert.equal(animation.keyframes[1].opacity, '0.4');
  animation.onfinish!();
  assert.deepEqual(disabled.style, { opacity: '0.4', transform: 'scale(0.9)' });
});

test('Reduce Motion cancels pending and running transitions and prevents new motion', () => {
  const h = harness(), person = h.node(0); h.nodes.push(person);
  h.animateLayout(false); assert.equal(h.frames.size, 0);
  h.animateLayout(true); person.top = 100; h.frame();
  const animation = person.animations[0];
  h.reduce(); assert.equal(animation.cancelled, true);
  h.animateLayout(true); assert.equal(h.frames.size, 0);
  const pending = harness(); pending.animateLayout(true); assert.equal(pending.frames.size, 1);
  pending.reduce(); assert.equal(pending.frames.size, 0);
});
