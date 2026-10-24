import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

function surface(options: { version?: string; module?: boolean; supported?: boolean; throws?: boolean; dark?: boolean } = {}) {
  let reduced = true, effect: (() => void | (() => void)) | undefined, cleanup: (() => void) | undefined, listener = (_value: boolean) => {};
  let resolve!: (value: boolean) => void, reject!: () => void, loads = 0, removed = 0;
  const preference = new Promise<boolean>((yes, no) => { resolve = yes; reject = () => no(Error('Unavailable')); });
  const motion = { enabled: true, active: true };
  const env = {
    React: { createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }) },
    Platform: { Version: options.version ?? '26.1' }, View: 'View',
    requireOptionalNativeModule: () => options.module === false ? null : {},
    require: (name: string) => { loads++; assert.equal(name, 'expo-glass-effect'); if (options.throws) throw Error('Missing native view'); return { GlassView: 'GlassView', isLiquidGlassAvailable: () => true, isGlassEffectAPIAvailable: () => options.supported !== false }; },
    useUI: () => ({ palette: { surface: 'opaque' }, dark: options.dark ?? false, motion }),
    useState: () => [reduced, (value: boolean) => { reduced = value; }],
    useEffect: (fn: () => void | (() => void)) => { effect = fn; },
    AccessibilityInfo: { isReduceTransparencyEnabled: () => preference, addEventListener: (_name: string, fn: (value: boolean) => void) => { listener = fn; return { remove() { removed++; } }; } },
  };
  const file = ts.createSourceFile('TabBarSurface.ios.tsx', readFileSync(new URL('../src/TabBarSurface.ios.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const body = file.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(file).replace(/^export (?:default )?/, '')).join('\n');
  const render = new Function('env', `with(env){${ts.transpile(body, { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React })};return TabBarSurface;}`)(env);
  return { render, motion, loads: () => loads, removed: () => removed, commit: () => { cleanup = effect?.() || undefined; }, unmount: () => cleanup?.(), resolve, reject, change: (value: boolean) => listener(value) };
}
const tick = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
const props = { style: { borderRadius: 28, padding: 4 }, children: { unchangedTabs: true } };

test('old iOS or a build without the native module never evaluates GlassView JS', () => {
  for (const options of [{ version: '18.7' }, { module: false }]) {
    const app = surface(options), tree = app.render(props);
    assert.equal(app.loads(), 0); assert.equal(tree.type, 'View'); assert.equal(tree.props.accessibilityRole, 'tablist');
    assert.equal(tree.children[0], props.children); assert.equal(tree.props.style[0], props.style);
  }
});

test('unsupported runtime API or a missing native view retains the opaque bar', () => {
  for (const options of [{ supported: false }, { throws: true }]) {
    const app = surface(options); assert.equal(app.render(props).type, 'View'); assert.equal(app.loads(), 1);
  }
});

test('supported glass keeps the same children and layout, honors the app theme and falls back for accessibility', async () => {
  const app = surface({ dark: true });
  assert.equal(app.render(props).type, 'View'); app.commit(); app.resolve(false); await tick();
  const glass = app.render(props);
  assert.equal(glass.type, 'GlassView'); assert.equal(glass.children[0], props.children); assert.equal(glass.props.style, props.style);
  assert.equal(glass.props.colorScheme, 'dark'); assert.equal(glass.props.glassEffectStyle, 'regular'); assert.equal(glass.props.isInteractive, true);
  app.change(true); assert.equal(app.render(props).type, 'View');
  app.change(false); app.motion.enabled = false; assert.equal(app.render(props).type, 'View');
  app.unmount(); assert.equal(app.removed(), 1);
});

test('late preference reads cannot override a newer reduce-transparency event or update after unmount', async () => {
  const app = surface(); app.render(props); app.commit(); app.change(true); app.resolve(false); await tick();
  assert.equal(app.render(props).type, 'View'); app.unmount();
  const failed = surface(); failed.render(props); failed.commit(); failed.reject(); await tick(); assert.equal(failed.render(props).type, 'View'); failed.unmount();
  const left = surface(); left.render(props); left.commit(); left.unmount(); left.resolve(false); await tick(); assert.equal(left.render(props).type, 'View');
});
