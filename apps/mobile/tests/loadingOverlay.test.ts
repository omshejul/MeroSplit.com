import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

function harness(os = 'ios') {
  const listeners = new Map<string, (event: any) => void>();
  const slots: any[] = [], effects = new Map<string, { deps: any[]; cleanup?: () => void }>();
  let index = 0, consumer = '';
  const React = {
    createElement: (type: any, props: any, ...children: any[]) => { if (type?.context) type.context.value = props.value; return { type, props: props ?? {}, children }; },
    createContext(value: any) { const context: any = { value }; context.Provider = { context }; return context; },
    useContext: (context: any) => context.value,
    useState(value: any) { const i = index++; slots[i] ??= value; return [slots[i], (next: any) => slots[i] = typeof next === 'function' ? next(slots[i]) : next]; },
    useMemo(fn: any) { return fn(); },
    useCallback(fn: any) { const i = index++; return slots[i] ??= fn; },
    useEffect(fn: () => any, deps: any[]) { if (!consumer) return; const old = effects.get(consumer); if (!old || deps.some((v, i) => v !== old.deps[i])) { old?.cleanup?.(); effects.set(consumer, { deps, cleanup: fn() }); } },
  };
  const modules: any = {
    react: { __esModule: true, default: React, ...React },
    'react-native': { Platform: { OS: os }, ActivityIndicator: 'Spinner', View: 'View', StyleSheet: { absoluteFill: { position: 'absolute', top: 0, bottom: 0, left: 0, right: 0 }, create: (v: any) => v } },
    'react-native-paper': { Portal: 'Portal', useTheme: () => ({ colors: { surface: '#222', primary: '#ccc' } }) },
  };
  const code = ts.transpile(readFileSync(new URL('../src/LoadingOverlay.tsx', import.meta.url), 'utf8'), { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 });
  const exports: any = {}; new Function('require', 'exports', 'document', code)((name: string) => { assert.ok(modules[name], name); return modules[name]; }, exports, { addEventListener: (key: string, fn: any) => listeners.set(key, fn), removeEventListener: (key: string) => listeners.delete(key) });
  const render = (inline = false) => { index = 0; consumer = ''; exports.LoadingProvider({ children: 'app' }); consumer = 'overlay'; return exports.default({ inline }); };
  return { render, listeners, use(id: string, active: boolean) { consumer = id; exports.useLoading(active); }, unmount(id: string) { effects.get(id)?.cleanup?.(); effects.delete(id); } };
}

test('overlapping reads/actions keep one overlay until every operation settles', () => {
  const h = harness(); assert.equal(h.render(), null);
  h.use('notification-read', true); assert.equal(h.render().type, 'Portal');
  h.use('export', true); h.render();
  h.use('notification-read', false); assert.equal(h.render().type, 'Portal', 'one response cannot hide another request');
  h.use('export', false); assert.equal(h.render(), null);
});

test('screen removal and strict effect replay release their requests without leaving a stuck spinner', () => {
  const h = harness(); h.render();
  h.use('read', true); h.render(); h.unmount('read'); assert.equal(h.render(), null);
  h.use('read', true); h.render(); h.unmount('read'); h.use('read', true); assert.ok(h.render());
  h.use('read', false); assert.equal(h.render(), null);
  h.unmount('read'); assert.equal(h.render(), null);
});

test('the same accessible centered backdrop covers the root portal and a native sheet window', () => {
  const h = harness(); h.render(); h.use('action', true);
  const portal = h.render(), overlay = portal.children[0], inline = h.render(true);
  assert.deepEqual(JSON.parse(JSON.stringify(inline)), JSON.parse(JSON.stringify(overlay)));
  assert.equal(overlay.props.accessibilityRole, 'progressbar');
  assert.equal(overlay.props.accessibilityState.busy, true);
  assert.equal(overlay.props.accessibilityViewIsModal, true);
  assert.equal(overlay.props.onStartShouldSetResponder(), true, 'backdrop consumes touches');
  assert.equal(overlay.props.style.position, 'absolute');
  assert.equal(overlay.props.style.alignItems, 'center');
  assert.equal(overlay.props.style.justifyContent, 'center');
  assert.match(overlay.props.style.backgroundColor, /^rgba/);
  assert.equal(overlay.children[0].props.style[1].backgroundColor, '#222');
  assert.equal(overlay.children[0].children[0].props.size, 'large');
});


test('web loading blocks keyboard activation and releases it after the request settles', () => {
  const h = harness('web'); h.render(); assert.equal(h.listeners.size, 0);
  h.use('save', true); h.render();
  let prevented = false, stopped = false;
  h.listeners.get('keydown')!({ preventDefault() { prevented = true; }, stopImmediatePropagation() { stopped = true; } });
  assert.ok(prevented && stopped);
  h.use('save', false); h.render(); assert.equal(h.listeners.size, 0);
});
