import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// Execute production subscription/hook code, replacing only React and OS APIs.
function production(env: Record<string, unknown>, file = 'motionShared.ts') {
  const code = ts.transpile(readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8'), { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS });
  const exports: Record<string, any> = {};
  new Function('require', 'exports', code)((name: string) => name === 'react' ? env.React : name === 'framer-motion' ? env.Framer : env, exports);
  return exports;
}
const tick = () => new Promise<void>(done => setImmediate(done));
function preferenceHarness(initialState = 'active') {
  const pending: { resolve: (value: boolean) => void; reject: (error: Error) => void }[] = [];
  const changes: { enabled: boolean; active: boolean }[] = [];
  let preference!: (value: boolean) => void, visibility!: (value: string) => void, removed = 0;
  const api = production({ AccessibilityInfo: {
    isReduceMotionEnabled: () => new Promise<boolean>((resolve, reject) => pending.push({ resolve, reject })),
    addEventListener: (_name: string, listener: typeof preference) => { preference = listener; return { remove: () => removed++ }; },
  }, AppState: { currentState: initialState, addEventListener: (_name: string, listener: typeof visibility) => { visibility = listener; return { remove: () => removed++ }; } } });
  const stop = api.observeMotionPreference((value: typeof changes[number]) => changes.push(value));
  return { pending, changes, stop, preference: (value: boolean) => preference(value), visibility: (value: string) => visibility(value), removed: () => removed };
}

test('motion starts disabled, reads the OS preference and responds to live changes', async () => {
  const h = preferenceHarness();
  assert.deepEqual(h.changes, [{ enabled: false, active: true }]);
  h.pending[0].resolve(false); await tick(); assert.equal(h.changes.at(-1)?.enabled, true);
  h.preference(true); assert.equal(h.changes.at(-1)?.enabled, false);
  h.preference(false); assert.equal(h.changes.at(-1)?.enabled, true);
  h.stop(); assert.equal(h.removed(), 2);
});
test('a late initial read cannot undo a newer live reduced-motion choice', async () => {
  const h = preferenceHarness(); h.preference(true);
  const count = h.changes.length; h.pending[0].resolve(false); await tick();
  assert.equal(h.changes.length, count); assert.equal(h.changes.at(-1)?.enabled, false); h.stop();
});
test('background disables motion; foreground rechecks before enabling and ignores stale reads', async () => {
  const h = preferenceHarness(); h.pending[0].resolve(false); await tick();
  h.visibility('background'); assert.deepEqual(h.changes.at(-1), { enabled: false, active: false });
  h.visibility('active'); assert.equal(h.changes.at(-1)?.enabled, false);
  h.visibility('background'); h.visibility('active');
  h.pending[1].resolve(false); await tick(); assert.equal(h.changes.at(-1)?.enabled, false);
  h.pending[2].resolve(true); await tick(); assert.equal(h.changes.at(-1)?.enabled, false);
  h.preference(false); assert.equal(h.changes.at(-1)?.enabled, true); h.stop();
});
test('unknown/inactive startup and failed preference reads keep motion off', async () => {
  for (const state of ['unknown', 'background', 'inactive']) {
    const h = preferenceHarness(state); h.pending[0].resolve(false); await tick();
    assert.equal(h.changes.at(-1)?.enabled, false); h.stop();
  }
  const h = preferenceHarness(); h.pending[0].reject(Error('unavailable')); await tick();
  assert.equal(h.changes.at(-1)?.enabled, false); h.stop();
});
test('unmount removes both subscriptions and ignores pending reads and already-delivered events', async () => {
  const h = preferenceHarness(); const count = h.changes.length; h.stop();
  h.pending[0].resolve(false); h.preference(false); h.visibility('active'); await tick();
  assert.equal(h.changes.length, count); assert.equal(h.removed(), 2);
});

function hooks() {
  const slots: any[] = []; let cursor = 0; let effects: (() => void)[] = [];
  return {
    React: {
      useState(initial: any) { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial; return [slots[index], (value: any) => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }]; },
      useRef(value: any) { const index = cursor++; return slots[index] ??= { current: value }; },
      useEffect(run: () => (() => void) | void, dependencies: unknown[]) {
        const index = cursor++, previous = slots[index];
        if (!previous || dependencies.some((value, i) => value !== previous.dependencies[i])) effects.push(() => { previous?.cleanup?.(); slots[index] = { dependencies, cleanup: run() }; });
      },
    },
    render<T>(run: () => T) { cursor = 0; effects = []; const result = run(); effects.forEach(run => run()); return result; },
    unmount() { slots.forEach(value => value?.cleanup?.()); },
  };
}
test('the shared transition starts settled, retargets rapid input and never replays on rerender or resume', () => {
  const react = hooks(), animations: any[] = [];
  class Value {
    current: number; running: any; stops = 0;
    constructor(value: number) { this.current = value; }
    stopAnimation() { this.stops++; if (this.running) this.running.cancelled = true; this.running = null; }
    setValue(value: number) { this.current = value; }
  }
  const api = production({ React: react.React, Platform: { OS: 'ios' }, Animated: { Value, timing(value: Value, options: any) {
    const animation = { target: options.toValue, from: value.current, cancelled: false, start() { value.running = animation; }, finish() { if (!animation.cancelled) value.current = animation.target; } };
    animations.push(animation); return animation;
  } }, Easing: { out: (value: unknown) => value, cubic: 'cubic' } });
  const render = (target: number, enabled = true) => react.render(() => api.useMotionValue(target, enabled)) as Value;
  const value = render(1); assert.equal(value.current, 1); assert.equal(animations.length, 0);
  assert.equal(render(0), value); value.current = 0.6;
  render(1); assert.equal(animations[0].cancelled, true); assert.equal(animations[1].from, 0.6);
  render(1); assert.equal(animations.length, 2, 'equal-target data/parent renders do not replay');
  render(1, false); assert.equal(animations[1].cancelled, true); assert.equal(value.current, 1);
  animations[0].finish(); animations[1].finish(); assert.equal(value.current, 1, 'old completions cannot replace the final state');
  render(1, true); assert.equal(animations.length, 2, 'reenabling/resuming does not replay');
  render(0, false); assert.equal(value.current, 0); assert.equal(animations.length, 2);
  render(1); react.unmount(); assert.equal(animations.at(-1).cancelled, true);
});

function component(file: string, name: string, env: Record<string, unknown>) {
  const source = ts.createSourceFile(file, readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let code = '';
  function find(node: ts.Node) { if (ts.isFunctionDeclaration(node) && node.name?.text === name) code = node.getText(source).replace(/^export (?:default )?/, ''); ts.forEachChild(node, find); }
  find(source); assert.ok(code);
  return new Function('env', `with(env) { ${ts.transpile(code, { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React })}; return ${name}; }`)(env);
}
const React = { createElement: (type: unknown, props: any, ...children: unknown[]) => ({ type, props, children }) };
test('Details open a dialog without expanding or shifting the surrounding row', () => {
  const h = hooks();
  const DetailDialog = component('DetailDialog.tsx', 'DetailDialog', { React: { ...React, Fragment: 'Fragment' }, ...h.React, View: 'View', SettingsRow: 'SettingsRow', KeyboardDialog: 'KeyboardDialog', Dialog: { Title: 'Title', Actions: 'Actions' }, DialogScrollBody: 'Body', Button: 'Button' });
  const child = { retainedIdentity: true }, render = (busy = false) => h.render(() => DetailDialog({ title: 'Details', children: child, busy }));
  let tree = render(); assert.equal(tree.children[1].props.visible, false); assert.equal(tree.children[0].props.accessibilityState, undefined);
  tree.children[0].props.onPress(); tree = render(); assert.equal(tree.children[1].props.visible, true);
  assert.equal(tree.children[1].children[1].children[0].children[0], child);
  render(true).children[1].props.onDismiss(); assert.equal(render(true).children[1].props.visible, true);
  render().children[1].props.onDismiss(); assert.equal(render().children[1].props.visible, false);
});
test('tab actions and selected/disabled semantics remain immediate and do not depend on animation completion', () => {
  const calls: string[] = [];
  const TabButton = component('AppNavigation.tsx', 'TabButton', { React, Button: 'Button', Platform: { OS: 'native' }, Pressable: 'Pressable', View: 'View', Text: 'Text', Icon: 'Icon', Animated: { View: 'AnimatedView' }, styles: {}, StyleSheet: { absoluteFill: {} }, radii: {}, useUI: () => ({ palette: {}, motion: { enabled: true } }), useMotionValue: () => 'in-flight' });
  const tree = TabButton({ item: { value: 'Account', label: 'Me', icon: 'me' }, selected: true, busy: false, onSelect: (value: string) => calls.push(value) });
  tree.props.onPress(); assert.deepEqual(calls, ['Account']); assert.deepEqual(tree.props.accessibilityState, { selected: true, disabled: false });
  const busy = TabButton({ item: { value: 'Groups' }, selected: false, busy: true, onSelect() {} }); assert.equal(busy.props.disabled, true);
});
test('shared press feedback releases, clears on disable/background, and works with reduced motion', () => {
  const h = hooks(); let active = true;
  const feedback = component('ui.tsx', 'usePressFeedback', { ...h.React, useUI: () => ({ motion: { active, enabled: false } }) });
  const render = (disabled = false) => h.render(() => feedback(disabled));
  let value = render(); value.onPressIn(); value = render(); assert.ok(value.pressedStyle.opacity < 1);
  value.onPressOut(); assert.equal(render().pressedStyle.opacity, 1);
  render().onPressIn(); render(true); assert.equal(render(true).pressedStyle.opacity, 1);
  render().onPressIn(); active = false; render(); active = true; assert.equal(render().pressedStyle.opacity, 1);
});

 test('web Framer transitions retarget current progress and settle immediately for reduced motion', () => {
  const h = hooks(), animations: any[] = [];
  class Value { current: number; constructor(value: number) { this.current = value; } setValue(value: number) { this.current = value; } }
  const api = production({ React: h.React, Animated: { Value }, Framer: { animate(from: number, target: number, options: any) {
    const animation = { from, target, options, stopped: false, stop() { this.stopped = true; } }; animations.push(animation); return animation;
  } } }, 'motion.web.ts');
  const render = (target: number, enabled = true) => h.render(() => api.useMotionValue(target, enabled)) as Value;
  const value = render(0); assert.equal(animations.length, 0);
  render(1); animations[0].options.onUpdate(0.4); assert.equal(value.current, 0.4);
  render(0); assert.equal(animations[0].stopped, true); assert.equal(animations[1].from, 0.4);
  render(0, false); assert.equal(value.current, 0); assert.equal(animations[1].stopped, true);
  render(0, true); assert.equal(animations.length, 2);
  render(1); h.unmount(); assert.equal(animations[2].stopped, true);
});
