import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

type Element = { type: unknown; props: Record<string, any>; children: unknown[] };
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
function elements(value: unknown): Element[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (!value || typeof value !== 'object' || !('children' in value)) return [];
  const node = value as Element; return [node, ...node.children.flatMap(elements)];
}
function one(tree: unknown, type: string) { const rows = elements(tree).filter(node => node.type === type); assert.equal(rows.length, 1, type); return rows[0]; }
function button(tree: unknown, title: string) { const value = elements(tree).find(node => node.type === 'Button' && node.props.title === title); assert.ok(value, title); return value; }
const session = { token: 'synthetic-one', baseUrl: 'https://example.invalid/', email: 'one@example.invalid', userId: '1' };
function harness(os = 'ios') {
  const slots: any[] = [], effects: (() => void)[] = [], calls: any[] = [], shares: any[] = [], urls: string[] = [], busy: boolean[] = [];
  const viewport = { height: 667, width: 375, fontScale: 1 }, insets = { top: 20, bottom: 0, left: 0, right: 0 };
  const listeners = new Map<string, (event: any) => void>(); let index = 0, focused = 0;
  let input = { session, busy: false, onBusyChange: (value: boolean) => busy.push(value) };
  let request: (session: unknown, path: string, method: string) => Promise<unknown> = async () => ({ connections: [] });
  const React = {
    Fragment: 'Fragment', createElement: (type: unknown, props: object | null, ...children: unknown[]): Element => ({ type, props: props ?? {}, children }),
    useState(initial: unknown) { const i = index++; if (!(i in slots)) slots[i] = initial; return [slots[i], (value: unknown) => { slots[i] = value; }]; },
    useRef(initial: unknown) { const i = index++; return slots[i] ??= { current: initial }; },
    useEffect(effect: () => (() => void) | void, deps: unknown[]) {
      const i = index++, prior = slots[i];
      if (!prior || deps.some((value, j) => !Object.is(value, prior.deps[j]))) {
        slots[i] = { deps, cleanup: prior?.cleanup };
        effects.push(() => { prior?.cleanup?.(); slots[i].cleanup = effect(); });
      }
    },
  };
  const modules: Record<string, unknown> = {
    react: { ...React, default: React },
    'react-native-safe-area-context': { useSafeAreaInsets: () => insets },
    'react-native': { useWindowDimensions: () => viewport, View: 'View', Platform: { OS: os }, Linking: { openURL: async (value: string) => { urls.push(value); } }, Share: { share: async (value: unknown) => { shares.push(value); } } },
    'react-native-paper': { Text: 'Text', Dialog: { Title: 'Title', Actions: 'Actions' } },
    './api': { request: (active: unknown, path: string, method = 'GET') => { calls.push({ session: active, path, method }); return request(active, path, method); } },
    './DialogParts': { DialogScrollBody: 'ScrollBody' }, './KeyboardDialog': { __esModule: true, default: 'KeyboardDialog' },
    './ui': { Button: 'Button', ErrorText: 'ErrorText', SettingsRow: 'SettingsRow', useUI: () => ({ ui: {} }) },
  };
  const exports: any = {}, source = readFileSync(new URL('../src/MCPSettings.tsx', import.meta.url), 'utf8');
  const code = ts.transpile(source, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React });
  new Function('require', 'exports', 'document', 'requestAnimationFrame', code)(
    (name: string) => { assert.ok(name in modules, name); return modules[name]; }, exports,
    { addEventListener: (name: string, fn: (event: any) => void) => listeners.set(name, fn), removeEventListener: (name: string) => listeners.delete(name) },
    (fn: () => void) => fn(),
  );
  return {
    calls, shares, urls, busy, listeners, viewport, insets,
    respond(handler: typeof request) { request = handler; },
    render(next: Partial<typeof input> = {}) { input = { ...input, ...next }; index = 0; const tree = exports.default(input); one(tree, 'SettingsRow').props.rowRef.current = { focus: () => focused++ }; return tree; },
    async flush() { effects.splice(0).forEach(effect => effect()); await turn(); },
    focusCount: () => focused,
    unmount() { slots.forEach(slot => slot?.cleanup?.()); },
  };
}

test('Me has one settings row, opens a persistent scrolling dialog and keeps Done outside the body', async () => {
  const app = harness(); let tree = app.render(); await app.flush(); tree = app.render();
  assert.equal(one(tree, 'SettingsRow').props.label, 'Connect MCP');
  assert.equal(one(tree, 'KeyboardDialog').props.visible, false);
  assert.equal(app.calls.length, 0, 'the closed settings row does not fetch connections');
  one(tree, 'SettingsRow').props.onPress(); tree = app.render();
  assert.equal(one(tree, 'KeyboardDialog').props.visible, true);
  assert.ok(elements(one(tree, 'ScrollBody')).some(node => node.type === 'Text' && node.children.includes('Loading connections…')));
  assert.equal(button(tree, 'Done').props.disabled, false, 'loading cannot trap someone in the dialog');
  assert.equal(elements(one(tree, 'ScrollBody')).includes(button(tree, 'Done')), false);
  assert.equal(one(tree, 'Actions').children[0], button(tree, 'Done'));
  await turn(); tree = app.render();
  assert.deepEqual(app.calls, [{ session, path: '/me/mcp', method: 'GET' }]);
  const text = elements(tree).filter(node => node.type === 'Text').flatMap(node => node.children).join(' ');
  assert.doesNotMatch(text, /https:\/\/|get_account_context|Connect MeroSplit to this client/);
  button(tree, 'Setup instructions').props.onPress(); button(tree, 'Share setup prompt').props.onPress(); await turn();
  assert.deepEqual(app.urls, ['https://example.invalid/mcp/setup']);
  assert.deepEqual(app.shares, [{ message: 'Connect MeroSplit to this client using the instructions at https://example.invalid/mcp/setup, then verify with get_account_context.' }]);
  button(tree, 'Done').props.onPress(); assert.equal(one(app.render(), 'KeyboardDialog').props.visible, false);
  assert.equal(app.focusCount(), 1); app.unmount();
});

test('Disconnect keeps shared busy guards, exact selected ID, one request and a reachable fixed footer', async () => {
  const app = harness(); let finish!: () => void;
  app.respond(async (_active, _path, method) => method === 'DELETE' ? new Promise<void>(resolve => { finish = resolve; }) : { connections: [{ id: 'client/one', client_name: 'Assistant One' }] });
  let tree = app.render(); await app.flush(); one(tree, 'SettingsRow').props.onPress(); await turn(); tree = app.render();
  const disconnect = button(tree, 'Disconnect'), done = button(tree, 'Done');
  assert.equal(disconnect.props.accessibilityLabel, 'Disconnect Assistant One');
  disconnect.props.onPress(); disconnect.props.onPress(); done.props.onPress(); tree = app.render();
  assert.equal(one(tree, 'KeyboardDialog').props.visible, true);
  assert.equal(one(tree, 'KeyboardDialog').props.dismissable, false);
  one(tree, 'KeyboardDialog').props.onDismiss(); assert.equal(app.focusCount(), 0);
  for (const title of ['Done', 'Disconnect', 'Refresh', 'Share setup prompt', 'Setup instructions']) assert.equal(button(tree, title).props.disabled, true);
  assert.deepEqual(app.busy, [true]);
  assert.equal(app.calls.filter(call => call.method === 'DELETE').length, 1);
  assert.equal(app.calls[1].path, '/me/mcp/client%2Fone');
  finish(); await turn(); assert.deepEqual(app.busy, [true, false]);
  tree = app.render(); assert.equal(button(tree, 'Done').props.disabled, false);
  assert.equal(app.calls.at(-1).method, 'GET'); app.unmount();
});

test('loading failure stays inline, Refresh retries and external busy blocks entry and dismissal', async () => {
  const app = harness(); app.respond(async () => { throw Error('synthetic offline'); });
  let tree = app.render(); await app.flush(); tree = app.render({ busy: true });
  one(tree, 'SettingsRow').props.onPress(); assert.equal(app.calls.length, 0);
  tree = app.render({ busy: false }); one(tree, 'SettingsRow').props.onPress(); await turn(); tree = app.render();
  assert.ok(one(tree, 'ErrorText').children.includes('Could not load connections. Try again.'));
  app.respond(async () => ({ connections: [] })); button(tree, 'Refresh').props.onPress(); await turn(); tree = app.render();
  assert.equal(elements(tree).filter(node => node.type === 'ErrorText').length, 0);
  tree = app.render({ busy: true }); one(tree, 'KeyboardDialog').props.onDismiss();
  assert.equal(one(app.render(), 'KeyboardDialog').props.visible, true); app.unmount();
});

test('session reset and unmount reject old connection responses', async () => {
  const app = harness(); let reply!: (value: unknown) => void;
  app.respond(() => new Promise(resolve => { reply = resolve; }));
  let tree = app.render(); await app.flush(); one(tree, 'SettingsRow').props.onPress();
  const next = { ...session, token: 'synthetic-two', userId: '2', email: 'two@example.invalid' };
  app.render({ session: next }); await app.flush();
  reply({ connections: [{ id: 'old', client_name: 'Previous account' }] }); await turn(); tree = app.render();
  assert.equal(one(tree, 'KeyboardDialog').props.visible, false);
  assert.equal(elements(tree).some(node => node.children.includes('Previous account')), false);
  one(tree, 'SettingsRow').props.onPress(); app.unmount();
  reply({ connections: [{ id: 'late', client_name: 'Unmounted response' }] }); await turn();
  assert.equal(elements(app.render()).some(node => node.children.includes('Unmounted response')), false);
});

test('web Escape closes and restores trigger focus while a busy dialog retains it', async () => {
  const app = harness('web'); let tree = app.render(); await app.flush(); one(tree, 'SettingsRow').props.onPress();
  app.render(); await app.flush();
  let prevented = 0; const event = { key: 'Escape', preventDefault: () => prevented++, stopPropagation() {} };
  app.listeners.get('keydown')!(event); assert.equal(app.focusCount(), 1);
  assert.equal(one(app.render(), 'KeyboardDialog').props.visible, false);
  one(app.render(), 'SettingsRow').props.onPress(); app.render({ busy: true }); await app.flush();
  app.listeners.get('keydown')!(event); assert.equal(prevented, 1);
  assert.equal(one(app.render(), 'KeyboardDialog').props.visible, true); app.unmount();
  assert.equal(app.listeners.size, 0);
});


test('the changing safe viewport bounds Paper iOS content, not just its outer shadow layer', () => {
  const createElement = (type: unknown, props: object, ...children: unknown[]): Element => ({ type, props, children });
  const shared = ts.createSourceFile('KeyboardDialog.tsx', readFileSync(new URL('../src/KeyboardDialog.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declaration = shared.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'KeyboardDialog')!;
  const renderDialog = new Function('env', `with(env) { ${ts.transpile(declaration.getText(shared).replace('export default ', ''), { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React })}; return KeyboardDialog; }`)(
    { React: { createElement }, Dialog: 'PaperDialog', Portal: 'Portal', KeyboardAvoidingView: 'KeyboardBoundary' });
  // Execute the INSTALLED iOS Surface style partition. Its container has two
  // layers: flexShrink goes outside; maxHeight constrains the content inside.
  // This checks the actual forwarding boundary, not native text/Yoga layout.
  const surface = ts.createSourceFile('Surface.tsx', readFileSync(new URL('../node_modules/react-native-paper/src/components/Surface.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declarations = surface.statements.filter(ts.isVariableStatement).flatMap(node => node.declarationList.declarations);
  const fields = declarations.find(node => node.name.getText(surface) === 'outerLayerStyleProperties')!;
  const ios = declarations.find(node => node.name.getText(surface) === 'SurfaceIOS')!;
  const splitModule: any = {};
  new Function('exports', ts.transpile(readFileSync(new URL('../node_modules/react-native-paper/src/utils/splitStyles.ts', import.meta.url), 'utf8'), { module: ts.ModuleKind.CommonJS }))(splitModule);
  const renderSurface = new Function('env', `with(env) { ${ts.transpile(`const ${fields.getText(surface)}; const ${ios.getText(surface)};`, { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React })}; return SurfaceIOS; }`)(
    { React: { createElement, useMemo: (fn: () => unknown) => fn() }, Animated: { View: 'IOSLayer' },
      StyleSheet: { flatten: (value: unknown) => Object.assign({}, ...[value].flat(Infinity)) },
      splitStyles: splitModule.splitStyles, forwardRef: (fn: Function) => fn, getStyleForShadowLayer: () => ({}) });
  function contentStyle(props: Record<string, any>) {
    const dialog = one(renderDialog({ ...props, children: [] }), 'PaperDialog');
    const outer = renderSurface({ container: true, elevation: 0, style: dialog.props.style }, null) as Element;
    assert.equal(outer.props.style.flexShrink, 1);
    return (outer.children[0] as Element).props.style;
  }
  assert.equal(contentStyle({ visible: true, onDismiss() {} }).maxHeight, undefined, 'other shared dialogs keep their original sizing');
  const app = harness(); let previous = 0;
  for (const height of [375, 667, 844]) {
    app.viewport.height = height; app.viewport.fontScale = 3.1;
    app.insets.top = 20; app.insets.bottom = 34;
    const dialog = one(app.render(), 'KeyboardDialog');
    const content = contentStyle(dialog.props);
    assert.ok(Number.isFinite(content.maxHeight));
    assert.ok(content.maxHeight > previous && content.maxHeight <= height - app.insets.top - app.insets.bottom);
    assert.equal(content.height, undefined, 'normal content keeps its intrinsic height instead of filling the viewport');
    previous = content.maxHeight;
  }
});
