import { withSharedUI } from './componentHarness.ts';
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
function one(tree: unknown, type: string) { const rows = elements(tree).filter(node => node.type === type && (type !== 'SettingsRow' || node.props.label === 'Connect MCP')); assert.equal(rows.length, 1, type); return rows[0]; }
function button(tree: unknown, title: string) { const value = elements(tree).find(node => (node.type === 'Button' && node.props.title === title || node.type === 'SettingsRow' && node.props.label === title)); assert.ok(value, title); return value; }
const session = { token: 'synthetic-one', baseUrl: 'https://example.invalid/', email: 'one@example.invalid', userId: '1' };
function harness(os = 'ios') {
  const slots: any[] = [], effects: (() => void)[] = [], calls: any[] = [], copies: string[] = [], busy: boolean[] = [], loading: boolean[] = [];
  const viewport = { height: 667, width: 375, fontScale: 1 }, insets = { top: 20, bottom: 0, left: 0, right: 0 };
  const listeners = new Map<string, (event: any) => void>(); let index = 0, focused = 0;
  let input = { session, busy: false, onBusyChange: (value: boolean) => busy.push(value) };
  let request: (session: unknown, path: string, method: string) => Promise<unknown> = async () => ({ connections: [] });
  let copy: () => Promise<void> = async () => {};
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
  const shared = withSharedUI({ React, Dialog: { Title: 'Title', Actions: 'Actions' }, View: 'View', Text: 'Text', Button: 'Button', ErrorText: 'ErrorText', useUI: () => ({ ui: {} }) });
  const modules: Record<string, unknown> = {
    './LoadingOverlay': { useLoading(value: boolean) { loading.push(value); } },
    './UIStates': { LoadingState: shared.LoadingState, EmptyState: shared.EmptyState, ErrorState: shared.ErrorState },
    react: { __esModule: true, ...React, default: shared.React },
    'react-native-safe-area-context': { useSafeAreaInsets: () => insets },
    'react-native': { useWindowDimensions: () => viewport, View: 'View', Platform: { OS: os },  },
    'react-native-paper': { Text: 'Text', Dialog: { Title: 'Title', Actions: 'Actions' } },
    './clipboard': { copyText: (value: string) => { copies.push(value); return copy(); } },
    './appLinks': { APP_ORIGIN: 'https://merosplit.com' },
    './api': { request: (active: unknown, path: string, method = 'GET') => { calls.push({ session: active, path, method }); return request(active, path, method); } },
    './DialogParts': { Dialog: { Title: 'Title', Actions: 'Actions' }, DialogScrollBody: 'ScrollBody' }, './KeyboardDialog': { __esModule: true, default: 'KeyboardDialog' },
    './ui': { Button: 'Button', ErrorText: 'ErrorText', SettingsRow: 'SettingsRow', Icon: 'Icon', useUI: () => ({ ui: {}, palette: { soft: '#2D2536' } }) },
  };
  const exports: any = {}, source = readFileSync(new URL('../src/MCPSettings.tsx', import.meta.url), 'utf8');
  const code = ts.transpile(source, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React });
  new Function('require', 'exports', 'document', 'requestAnimationFrame', code)(
    (name: string) => { assert.ok(name in modules, name); return modules[name]; }, exports,
    { addEventListener: (name: string, fn: (event: any) => void) => listeners.set(name, fn), removeEventListener: (name: string) => listeners.delete(name) },
    (fn: () => void) => fn(),
  );
  return {
    calls, copies, busy, loading, listeners, viewport, insets,
    copyWith(handler: typeof copy) { copy = handler; },
    respond(handler: typeof request) { request = handler; },
    render(next: Partial<typeof input> = {}) { input = { ...input, ...next }; index = 0; const tree = exports.default(input); one(tree, 'SettingsRow').props.rowRef.current = { focus: () => focused++ }; return tree; },
    async flush() { effects.splice(0).forEach(effect => effect()); await turn(); },
    focusCount: () => focused,
    unmount() { slots.forEach(slot => slot?.cleanup?.()); },
  };
}

test('Connect MCP offers clipboard setup and a device list, with header dismissal', async () => {
  const app = harness(); let tree = app.render(); await app.flush(); tree = app.render();
  assert.equal(one(tree, 'SettingsRow').props.label, 'Connect MCP');
  assert.equal(one(tree, 'KeyboardDialog').props.visible, false);
  assert.equal(app.loading.at(-1), false, 'closed settings do not show the global overlay');
  assert.equal(app.calls.length, 0, 'the closed settings row does not fetch connections');
  one(tree, 'SettingsRow').props.onPress(); tree = app.render();
  assert.equal(one(tree, 'KeyboardDialog').props.visible, true);
  assert.equal(app.loading.at(-1), true, 'open settings register the actual pending read');
  assert.ok(elements(one(tree, 'ScrollBody')).some(node => node.type === 'Text' && node.children.includes('Loading connections…')));
  assert.equal(one(tree, 'KeyboardDialog').props.dismissable, true, 'loading cannot trap someone in the dialog');
  await turn(); tree = app.render();
  assert.deepEqual(app.calls, [{ session, path: '/me/mcp', method: 'GET' }]);
  const text = elements(tree).filter(node => node.type === 'Text').flatMap(node => node.children).join(' ');
  assert.doesNotMatch(text, /https:\/\/|get_account_context|Connect MeroSplit to this client/);
  assert.match(text, /Connected devices/);
  assert.match(text, /No connected devices/);
  assert.deepEqual(elements(tree).filter(node => node.type === 'Button').map(node => node.props.title), ['Copy prompt']);
  button(tree, 'Copy prompt').props.onPress(); await turn(); tree = app.render();
  assert.deepEqual(app.copies, ['Connect MeroSplit to this client using the instructions at https://merosplit.com/mcp/setup, then verify with get_account_context.']);
  assert.ok(button(tree, 'Copied'));
  one(tree, 'KeyboardDialog').props.onDismiss(); assert.equal(one(app.render(), 'KeyboardDialog').props.visible, false);
  assert.equal(app.focusCount(), 1); app.unmount();
});

test('clipboard denial reports failure and permits retry without making a ledger request', async () => {
  const app = harness(); let tree = app.render(); await app.flush(); one(tree, 'SettingsRow').props.onPress(); await turn();
  app.copyWith(async () => { throw Error('clipboard denied'); });
  button(app.render(), 'Copy prompt').props.onPress(); await turn(); tree = app.render();
  assert.ok(one(tree, 'ErrorText').children.includes('Could not copy the prompt. Try again.'));
  assert.equal(elements(tree).some(node => node.props.title === 'Copied'), false);
  app.copyWith(async () => {}); button(tree, 'Copy prompt').props.onPress(); await turn(); tree = app.render();
  assert.ok(button(tree, 'Copied'));
  assert.equal(elements(tree).some(node => node.type === 'ErrorText'), false);
  assert.equal(app.calls.length, 1); app.unmount();
});

test('Disconnect keeps busy guards and the selected ID, then reloads devices', async () => {
  const app = harness(); let finish!: () => void;
  app.respond(async (_active, _path, method) => method === 'DELETE' ? new Promise<void>(resolve => { finish = resolve; }) : { connections: [{ id: 'client/one', client_name: 'Assistant One' }] });
  let tree = app.render(); await app.flush(); one(tree, 'SettingsRow').props.onPress(); await turn(); tree = app.render();
  const disconnect = button(tree, 'Disconnect');
  assert.equal(disconnect.props.accessibilityLabel, 'Disconnect Assistant One');
  disconnect.props.onPress(); disconnect.props.onPress(); one(tree, 'KeyboardDialog').props.onDismiss(); tree = app.render();
  assert.equal(one(tree, 'KeyboardDialog').props.visible, true);
  assert.equal(one(tree, 'KeyboardDialog').props.dismissable, false);
  assert.equal(app.focusCount(), 0);
  for (const title of ['Disconnect', 'Copy prompt']) assert.equal(button(tree, title).props.disabled, true);
  assert.deepEqual(app.busy, [true]);
  assert.equal(app.loading.at(-1), true, 'disconnect keeps the overlay until its request and refresh finish');
  assert.equal(app.calls.filter(call => call.method === 'DELETE').length, 1);
  assert.equal(app.calls[1].path, '/me/mcp/client%2Fone');
  finish(); await turn(); assert.deepEqual(app.busy, [true, false]);
  assert.equal(one(app.render(), 'KeyboardDialog').props.dismissable, true);
  assert.equal(app.calls.at(-1).method, 'GET'); assert.equal(app.loading.at(-1), false); app.unmount();
});

test('loading failure stays inline, reopening retries and external busy blocks entry and dismissal', async () => {
  const app = harness(); app.respond(async () => { throw Error('synthetic offline'); });
  let tree = app.render(); await app.flush(); tree = app.render({ busy: true });
  one(tree, 'SettingsRow').props.onPress(); assert.equal(app.calls.length, 0);
  tree = app.render({ busy: false }); one(tree, 'SettingsRow').props.onPress(); await turn(); tree = app.render();
  assert.ok(one(tree, 'ErrorText').children.includes('Could not load connected devices. Close and reopen to try again.'));
  app.respond(async () => ({ connections: [] })); one(tree, 'KeyboardDialog').props.onDismiss();
  one(app.render(), 'SettingsRow').props.onPress(); await turn(); tree = app.render();
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
  one(app.render(), 'KeyboardDialog').props.onDismiss(); assert.equal(app.focusCount(), 1);
  assert.equal(one(app.render(), 'KeyboardDialog').props.visible, false);
  one(app.render(), 'SettingsRow').props.onPress(); app.render({ busy: true }); await app.flush();
  one(app.render({ busy: true }), 'KeyboardDialog').props.onDismiss();
  assert.equal(one(app.render(), 'KeyboardDialog').props.visible, true); app.unmount();
  assert.equal(app.listeners.size, 0);
});


test('the changing safe viewport bounds Paper iOS content, not just its outer shadow layer', () => {
  const createElement = (type: unknown, props: object, ...children: unknown[]): Element => ({ type, props, children });
  const shared = ts.createSourceFile('KeyboardDialog.tsx', readFileSync(new URL('../src/KeyboardDialog.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declaration = shared.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'KeyboardDialog')!;
  let measuredHeight: number | undefined;
  const renderDialog = new Function('env', `with(env) { ${ts.transpile(declaration.getText(shared).replace('export default ', ''), { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React })}; return KeyboardDialog; }`)(
    withSharedUI({ React: { createElement }, DialogContext: { Provider: 'DialogProvider' }, DialogFocus: 'DialogFocus', useUI: () => ({ palette: {}, motion: { enabled: false } }), Platform: { OS: 'ios' }, useWindowDimensions: () => ({ width: 375, height: 1000 }), Dialog: 'PaperDialog', Portal: 'Portal', KeyboardAvoidingView: 'KeyboardBoundary', useSafeAreaInsets: () => ({ top: 20, bottom: 34 }), useState: () => [measuredHeight, (value: number) => { measuredHeight = value; }] }));
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
    withSharedUI({ React: { createElement, useMemo: (fn: () => unknown) => fn() }, Animated: { View: 'IOSLayer' },
      StyleSheet: { flatten: (value: unknown) => Object.assign({}, ...[value].flat(Infinity)) },
      splitStyles: splitModule.splitStyles, forwardRef: (fn: Function) => fn, getStyleForShadowLayer: () => ({}) }));
  function contentStyle(props: Record<string, any>) {
    const dialog = one(renderDialog({ ...props, visible: true, children: [] }), 'PaperDialog');
    const outer = renderSurface({ container: true, elevation: 0, style: dialog.props.style }, null) as Element;
    assert.equal(outer.props.style.flexShrink, 1);
    return (outer.children[0] as Element).props.style;
  }
  assert.equal(contentStyle({ visible: true, onDismiss() {} }).maxHeight, 914, 'all dialogs stay inside the safe viewport');
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
  const props = one(app.render(), 'KeyboardDialog').props;
  const boundary = one(renderDialog({ ...props, children: [] }), 'KeyboardBoundary');
  boundary.props.onLayout({ nativeEvent: { layout: { height: 433 } } });
  assert.equal(contentStyle(props).maxHeight, 347, 'keyboard-resized height reaches the actual inner iOS Surface content layer');
  boundary.props.onLayout({ nativeEvent: { layout: { height: 844 } } });
  assert.equal(contentStyle(props).maxHeight, 758, 'MCP restores its original safe-window cap after keyboard dismissal');
});

test('confirmed connection lists stay usable without a global spinner during background revalidation', async () => {
  const app = harness(); let tree = app.render(); await app.flush();
  one(tree, 'SettingsRow').props.onPress(); await turn(); tree = app.render();
  one(tree, 'KeyboardDialog').props.onDismiss(); app.render();
  let finish!: (value: unknown) => void; app.respond(() => new Promise(resolve => { finish = resolve; }));
  one(app.render(), 'SettingsRow').props.onPress(); tree = app.render();
  assert.equal(one(tree, 'KeyboardDialog').props.visible, true);
  assert.equal(app.loading.at(-1), false, 'known connections remain visible while revalidating');
  finish({ connections: [] }); await turn(); app.render(); assert.equal(app.loading.at(-1), false); app.unmount();
});
