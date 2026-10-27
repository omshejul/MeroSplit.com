import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
function harness(enabled = true) {
  const listeners = new Map<string, (event: any) => void>(), animations: any[] = [];
  let cleanup: (() => void) | undefined;
  class Element {
    disabled = false; style = { transform: '', opacity: '' };
    closest(selector: string) { return selector.startsWith('[inert]') ? null : this; }
    matches(selector: string) { return selector.includes(':disabled') && this.disabled; }
    contains(target: unknown) { return target === this; }
  }
  class PointerEvent { isPrimary = true; button = 0; pointerType = 'mouse'; target: Element; relatedTarget: unknown; constructor(target: Element, relatedTarget: unknown = null) { this.target = target; this.relatedTarget = relatedTarget; } }
  class KeyboardEvent { repeat = false; target: Element; key: string; constructor(target: Element, key: string) { this.target = target; this.key = key; } }
  const events = { addEventListener: (name: string, fn: any) => listeners.set(name, fn), removeEventListener: (name: string) => listeners.delete(name) };
  const env = { document: events, window: events, Element, HTMLElement: Element, Node: Element, PointerEvent, KeyboardEvent };
  const exports: any = {};
  const code = ts.transpile(readFileSync(new URL('../src/useWebInteractions.web.ts', import.meta.url), 'utf8'), { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS });
  const require = (name: string) => name === 'react' ? { useEffect: (effect: () => any) => { cleanup = effect(); } } : { animate: (element: Element, values: unknown) => {
    const animation = { element, values, cancelled: false, cancel() { this.cancelled = true; }, stop() { this.cancelled = true; }, then() {} };
    animations.push(animation); return animation;
  } };
  new Function('require', 'exports', 'env', `with(env) { ${code} }`)(require, exports, env);
  exports.useWebInteractions(enabled);
  return { listeners, animations, Element, PointerEvent, KeyboardEvent, cleanup: () => cleanup?.(), send: (name: string, event: any = {}) => listeners.get(name)?.(event) };
}
test('pointer and keyboard feedback release, disabled controls ignore input, cleanup cancels motion', () => {
  const h = harness(), button = new h.Element();
  h.send('pointerdown', new h.PointerEvent(button));
  assert.deepEqual(h.animations.at(-1).values, { scale: 0.98, opacity: 0.8 });
  h.send('pointercancel');
  assert.deepEqual(h.animations.at(-1).values, { scale: 1, opacity: 1 });
  assert.equal(h.animations[0].cancelled, true);
  button.disabled = true; h.send('pointerdown', new h.PointerEvent(button)); assert.equal(h.animations.length, 2);
  button.disabled = false;
  const key = new h.KeyboardEvent(button, ' ');
  key.repeat = true; h.send('keydown', key); assert.equal(h.animations.length, 2);
  key.repeat = false; h.send('keydown', key); h.send('keyup'); assert.equal(h.animations.length, 4);
  h.cleanup(); assert.equal(h.listeners.size, 0); assert.ok(h.animations.every(a => a.cancelled));
});
test('reduced motion installs no listeners or animations', () => {
  const h = harness(false); assert.equal(h.listeners.size, 0); assert.equal(h.animations.length, 0); h.cleanup();
});
test('hover ignores touch and movements inside the same control', () => {
  const h = harness(), button = new h.Element(), touch = new h.PointerEvent(button); touch.pointerType = 'touch';
  h.send('pointerover', touch); h.send('pointerover', new h.PointerEvent(button, button)); assert.equal(h.animations.length, 0);
  h.send('pointerover', new h.PointerEvent(button)); assert.deepEqual(h.animations.at(-1).values, { scale: 1, opacity: 0.9 });
  h.send('pointerout', new h.PointerEvent(button)); assert.deepEqual(h.animations.at(-1).values, { scale: 1, opacity: 1 }); h.cleanup();
});
