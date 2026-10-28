import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { signInTopPadding } from '../src/authLayoutMetrics.ts';

const require = createRequire(import.meta.url);
const nativeRequire = createRequire(require.resolve('react-native/package.json'));
const babel = nativeRequire('@babel/core');
const presetRequire = createRequire(nativeRequire.resolve('babel-preset-expo'));
type Node = { type: any; props: any; children: any[] };
const React = { createElement: (type: any, props: any, ...children: any[]): Node => ({ type, props: props ?? {}, children }) };

function chatViewport(os: string, top: number) {
  const host = keyboardBoundary(os);
  const source = ts.createSourceFile('BillChatScreen.tsx', readFileSync(new URL('../src/BillChatScreen.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const screen = source.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'BillChatScreen') as ts.FunctionDeclaration;
  const returned = screen.body!.statements.find(ts.isReturnStatement)!.expression as ts.JsxElement;
  const root = ts.factory.createJsxSelfClosingElement(returned.openingElement.tagName, undefined, returned.openingElement.attributes);
  const viewport = screen.body!.statements.find(n => ts.isVariableStatement(n) && n.declarationList.declarations.some(d => d.name.getText(source) === 'Viewport'));
  const code = `${viewport?.getText(source) ?? ''}\nconst tree=${ts.createPrinter().printNode(ts.EmitHint.Unspecified, root, source)};return tree;`;
  const tree = new Function('env', `with(env){${ts.transpile(code, {target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React})}}`)({ React, Platform: {OS:os}, KeyboardAvoidingView:host.KAV, View:'View', insets:{top} });
  return {...host,tree};
}

test('chat composer stays above Android IME, restores on hide and avoids double shrink', async () => {
  const top=35, bottom=24, header=56, window=800, keyboardTop=470, original=window-top-bottom-header;
  const host=chatViewport('android',top), node=host.tree;
  let instance:any, available=original;
  if(node.type===host.KAV){
    instance=new host.KAV({...node.props,children:'chat list and composer'});instance.componentDidMount();
    await instance._onLayout({persist(){},nativeEvent:{layout:{x:0,y:header,width:390,height:original}}});
    instance._onKeyboardChange({duration:0,endCoordinates:{screenY:keyboardTop}});await instance._updateBottomIfNecessary();
    const style=flat(instance.render().props.style);available=(style.height??original)-(style.paddingBottom??0);
  }
  const composerBottom=top+header+available;
  assert.ok(composerBottom<=keyboardTop,`Chat composer bottom ${composerBottom} is hidden behind keyboard starting at ${keyboardTop}`);
  assert.equal(composerBottom,keyboardTop,'No extra bottom gap');
  const resized=keyboardTop-top-header;
  await instance._onLayout({persist(){},nativeEvent:{layout:{x:0,y:header,width:390,height:resized}}});await instance._updateBottomIfNecessary();
  const resizedStyle=flat(instance.render().props.style);assert.equal((resizedStyle.height??resized)-(resizedStyle.paddingBottom??0),resized,'OS-resized windows must not shrink twice');
  instance._onKeyboardChange(null);await instance._updateBottomIfNecessary();assert.equal(flat(instance.render().props.style).height,undefined);assert.equal(flat(instance.render().props.style).paddingBottom??0,0);
  instance.componentWillUnmount();assert.equal(host.listeners.size,0);
});

test('chat keeps the existing iOS/web viewport without a second keyboard boundary',()=>{
  for(const os of ['ios','web']){const {tree}=chatViewport(os,35);assert.equal(tree.type,'View');assert.equal(tree.props.behavior,undefined);assert.equal(tree.props.style.flex,1);}
});
const nodes = (value: any): Node[] => Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object' && 'children' in value ? [value, ...nodes(value.children)] : [];
const one = (tree: Node, id: string) => { const found = nodes(tree).filter(n => n.props.testID === id); assert.equal(found.length, 1); return found[0]; };

// Execute the installed RN implementation. Native event delivery and Yoga's
// single flex-child constraint are supplied by the host, not a fake KAV formula.
function keyboardBoundary(os: string) {
  const listeners = new Map<string, Function>();
  class Component {
    props: any; state: any;
    constructor(props: any) { this.props = props; }
    setState(update: any) { this.state = { ...this.state, ...update }; }
  }
  const keyboard = { isVisible: () => false, addListener: (name: string, callback: Function) => { listeners.set(name, callback); return { remove: () => listeners.delete(name) }; } };
  const exports: any = {};
  const file = require.resolve('react-native/Libraries/Components/Keyboard/KeyboardAvoidingView');
  const output = babel.transformSync(readFileSync(file, 'utf8'), { filename: file, configFile: false, babelrc: false, plugins: ['babel-plugin-syntax-hermes-parser', '@babel/plugin-transform-flow-strip-types', '@babel/plugin-transform-react-jsx', '@babel/plugin-transform-modules-commonjs'].map(name => presetRequire.resolve(name)) }).code;
  runInNewContext(output, { exports, require: (name: string) => {
    if (name.startsWith('@babel/runtime/')) return nativeRequire(name);
    if (name === 'react/jsx-runtime') return { jsx: (type: any, props: any) => React.createElement(type, props, props.children), jsxs: (type: any, props: any) => React.createElement(type, props, props.children) };
    if (name === 'react') return { ...React, Component, createRef: () => ({ current: null }) };
    if (name.includes('StyleSheet')) return { compose: (a: any, b: any) => [a, b] };
    if (name.includes('LayoutAnimation')) return { configureNext() {}, Types: {} };
    if (name.includes('Platform')) return { OS: os };
    if (name.includes('AccessibilityInfo')) return { prefersCrossFadeTransitions: async () => false };
    if (name === './Keyboard') return keyboard;
    if (name.endsWith('/View')) return 'View';
    throw new Error(name);
  } });
  return { KAV: exports.default, listeners };
}

function layout(os: string, top: number, visualViewport?: any) {
  const { KAV, listeners } = keyboardBoundary(os);
  const source = ts.createSourceFile('SignInLayout.tsx', readFileSync(new URL('../src/SignInLayout.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const decl = source.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'SignInLayout')!;
  let cursor = 0; const state: any[] = [], cleanup: Function[] = [];
  let mounted = false;
  const scope = { React, View: 'View', ScrollView: 'ScrollView', Image: 'Image', Text: 'Text', IconAction: 'IconAction', KeyboardAvoidingView: KAV, Platform: { OS: os },
    require: () => 'mark', window: { visualViewport }, signInTopPadding, useUI: () => ({ palette: {}, ui: {} }), useSafeAreaInsets: () => ({ top, bottom: 24 }),
    useState: (initial: any) => { const i = cursor++; if (!(i in state)) state[i] = initial; return [state[i], (value: any) => { state[i] = value; }]; },
    useEffect: (effect: Function) => { if (!mounted) { const stop = effect(); if (stop) cleanup.push(stop); } } };
  const render = new Function('env', `with(env){${ts.transpileModule(decl.getText(source).replace(/^export default /, ''), { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText};return SignInLayout;}`)(scope);
  return { KAV, listeners, render: (props: any) => { cursor = 0; const tree = render(props); mounted = true; return tree; }, cleanup: () => cleanup.forEach(stop => stop()) };
}

const density = 420 / 160;
// Exact AAB30 native failure: ScrollView[0,109][1080,1857], IMEtop1048.
const top = 109 / density, fullHeight = (1857 - 109) / density, keyboardY = 1048 / density;
const event = (height: number) => ({ persist() {}, nativeEvent: { layout: { x: 0, y: 0, width: 1080 / density, height } } });
function flat(style: any): any { return Array.isArray(style) ? Object.assign({}, ...style.map(flat)) : style ?? {}; }

async function avoid(host: ReturnType<typeof layout>, tree: Node, frameHeight: number, keyboardTop: number) {
  const boundary = nodes(tree).find(n => n.type === host.KAV);
  if (!boundary) return { available: frameHeight, instance: null };
  const instance = new host.KAV({ ...boundary.props, children: boundary.children });
  instance.componentDidMount(); await instance._onLayout(event(frameHeight));
  instance._onKeyboardChange({ duration: 0, endCoordinates: { screenY: keyboardTop } });
  await instance._updateBottomIfNecessary();
  const style = flat(instance.render().props.style);
  return { available: (style.height ?? frameHeight) - (style.paddingTop ?? 0) - (style.paddingBottom ?? 0), instance };
}

test('actual sign-in viewport is constrained above the observed Android IME by installed RN geometry', async t => {
  const host = layout('android', top), child = { type: 'EmailForm', props: {}, children: [] };
  let tree = host.render({ children: child, busy: false });
  const before = one(tree, 'signin-viewport'); before.props.onLayout(event(fullHeight));
  tree = host.render({ children: child, busy: false });
  const { available, instance } = await avoid(host, tree, fullHeight, keyboardY);
  t.diagnostic(JSON.stringify({ scenario: 'observed-short-Android-frame', beforeBottomPx: 1857, predictedViewportBottomPx: (top + available) * density, IMETopPx: 1048, topSafeAreaPx: 109 }));
  assert.ok(top + available <= keyboardY + 0.001, `Viewport bottom${(top + available) * density}px overlaps IME1048px`);
  assert.ok(available > 0);
  before.props.onLayout(event(available)); tree = host.render({ children: child, busy: false });
  assert.ok(nodes(tree).includes(child), 'Keep the same input/form child mounted');
  assert.equal(nodes(tree).find(n => n.type === 'ScrollView')!.props.keyboardShouldPersistTaps, 'handled');
  assert.deepEqual([...host.listeners.keys()], ['keyboardDidHide', 'keyboardDidShow']);
  instance.componentWillUnmount(); assert.equal(host.listeners.size, 0);
});

test('Android keyboard viewport remeasures centering, scrolls enlarged content, restores and avoids double shrink', async () => {
  const host = layout('android', top), props = { children: 'form', busy: false };
  let tree = host.render(props); one(tree, 'signin-viewport').props.onLayout(event(fullHeight));
  tree = host.render(props); const { available, instance } = await avoid(host, tree, fullHeight, keyboardY);
  assert.ok(instance, 'Android needs an active keyboard boundary');
  for (const contentHeight of [240, 520, 960]) {
    one(tree, 'signin-group').props.onLayout(event(contentHeight)); one(tree, 'signin-viewport').props.onLayout(event(available)); tree = host.render(props);
    const scroll = nodes(tree).find(n => n.type === 'ScrollView')!;
    assert.equal(scroll.props.contentContainerStyle.paddingTop, signInTopPadding(available, contentHeight));
    assert.equal(scroll.props.contentContainerStyle.flexGrow, 1);
    assert.equal(scroll.props.keyboardDismissMode, 'none');
    const scrollRange = Math.max(0, scroll.props.contentContainerStyle.paddingTop + contentHeight + scroll.props.contentContainerStyle.paddingBottom - available);
    assert.ok(scrollRange + available >= scroll.props.contentContainerStyle.paddingTop + contentHeight, 'The final action remains reachable by scrolling at larger font sizes');
  }
  // If native resize later arrives, let real RN recompute its avoidance instead
  // of subtracting the IME height a second time.
  await instance._onLayout(event(keyboardY - top));
  const resized = flat(instance.render().props.style);
  assert.equal((resized.height ?? (keyboardY - top)) - (resized.paddingBottom ?? 0), keyboardY - top);
  instance._onKeyboardHide(null); await instance._updateBottomIfNecessary();
  const restored = flat(instance.render().props.style); assert.equal(restored.paddingBottom ?? 0, 0);
  one(tree, 'signin-viewport').props.onLayout(event(fullHeight)); tree = host.render(props);
  const scroll = nodes(tree).find(n => n.type === 'ScrollView')!; assert.equal(scroll.props.contentContainerStyle.paddingTop, signInTopPadding(fullHeight, 960));
  instance.componentWillUnmount();
});

test('iOS and web keep their existing viewport, safe insets, back action and visualViewport lifecycle', () => {
  for (const os of ['ios', 'web']) {
    const handlers = new Map<string, Function>(); let backs = 0;
    const vv = { height: 500, addEventListener: (name: string, fn: Function) => handlers.set(name, fn), removeEventListener: (name: string) => handlers.delete(name) };
    const host = layout(os, 20, vv), props = { children: 'original form', busy: true, onBack: () => backs++ };
    let tree = host.render(props); tree = host.render(props);
    assert.equal(nodes(tree).some(n => n.type === host.KAV), false, 'Do not add another keyboard boundary on iOS or web');
    const viewport = one(tree, 'signin-viewport'); assert.equal(viewport.type, 'View'); assert.equal(viewport.props.style.flex, 1);
    assert.equal(viewport.props.style.maxHeight, os === 'web' ? 456 : undefined);
    assert.equal(nodes(tree).find(n => n.type === 'ScrollView')!.props.keyboardDismissMode, 'on-drag');
    const back = nodes(tree).find(n => n.type === 'IconAction')!; assert.equal(back.props.disabled, true); back.props.onPress(); assert.equal(backs, 1);
    assert.equal(handlers.size, os === 'web' ? 1 : 0); host.cleanup(); assert.equal(handlers.size, 0);
  }
});

function nativeScrollHandlers(props: any) {
  const source = readFileSync(require.resolve('react-native/Libraries/Components/ScrollView/ScrollView'), 'utf8');
  const output = babel.transformSync(source, { filename: 'ScrollView.js', configFile: false, babelrc: false, ast: true,
    plugins: ['babel-plugin-syntax-hermes-parser', '@babel/plugin-transform-flow-strip-types', '@babel/plugin-transform-react-jsx'].map(name => presetRequire.resolve(name)) });
  const selected: any[] = [];
  babel.traverse(output.ast, { ClassProperty(path: any) { if (['_handleScrollBeginDrag', '_handleStartShouldSetResponderCapture'].includes(path.node.key.name)) selected.push(path.node); } });
  assert.equal(selected.length, 2);
  const generate = presetRequire('@babel/generator').default;
  let dismissed = 0, focused = true;
  const env = { Platform: { OS: 'android' }, FrameRateLogger: { beginScroll() {} }, dismissKeyboard: () => { dismissed++; focused = false; }, TextInputState: { isTextInput: () => false } };
  const Handlers = new Function('env', `with(env){return class { constructor(props){this.props=props;} _isAnimating=()=>false; _softKeyboardIsDetached=()=>false; _keyboardIsDismissible=()=>true; ${selected.map(node => generate(node).code).join('\n')} };}`)(env);
  return { handler: new Handlers(props), dismissCount: () => dismissed, isFocused: () => focused };
}

test('real Android ScrollView drag keeps the IME open and handled Send taps are not captured to dismiss it', async t => {
  const host = layout('android', top), tree = host.render({ children: 'form', busy: false });
  const scroll = nodes(tree).find(n => n.type === 'ScrollView')!;
  const { handler, dismissCount, isFocused } = nativeScrollHandlers(scroll.props);
  handler._handleScrollBeginDrag({ nativeEvent: {} });
  assert.equal(isFocused(), true, 'Real drag handler leaves the focused input alone');
  assert.equal(dismissCount(), 0, 'Scrolling to Send must not merely dismiss the keyboard');
  assert.equal(handler._handleStartShouldSetResponderCapture({ target: {} }), false, 'The first handled action tap reaches the button');
  assert.notEqual(scroll.props.scrollEnabled, false);
  const { available, instance } = await avoid(host, tree, fullHeight, keyboardY);
  // Native measured Send[1100..1226], with already-minimal24dp top padding.
  // Even the smallest possible intrinsic group ending at Send gives enough
  // actual scroll extent to bring both Email and Send wholly above the IME.
  const sendBottom = (1226 - 109) / density, minimumGroupHeight = sendBottom - 24;
  one(tree, 'signin-group').props.onLayout(event(minimumGroupHeight)); one(tree, 'signin-viewport').props.onLayout(event(available));
  const measured = nodes(host.render({ children: 'form', busy: false })).find(n => n.type === 'ScrollView')!;
  const style = measured.props.contentContainerStyle;
  assert.equal(style.paddingTop, 24);
  const range = Math.max(0, style.paddingTop + minimumGroupHeight + style.paddingBottom - available);
  const required = sendBottom - available;
  t.diagnostic(JSON.stringify({ scenario: 'Send-reachable-by-scroll-without-dismiss', keyboardDismissCalls: dismissCount(), focusRetainedByJSHandler: isFocused(), predictedMinimumScrollRangePx: range * density, requiredScrollPx: required * density, SendAfterScrollPx: [1100 - required * density, 1226 - required * density], EmailAfterScrollPx: [942 - required * density, 1068 - required * density] }));
  assert.ok(required > 0 && range >= required, 'Send must be scroll-reachable while IME remains open');
  assert.ok((1226 / density - required) <= keyboardY + 0.001);
  assert.ok((1068 / density - required) <= keyboardY, 'Email also remains visible at that offset');
  instance?.componentWillUnmount();
});

test('actual AppFrame owns safe-area top and only Android sign-in adds keyboard avoidance', () => {
  const source = ts.createSourceFile('AppNavigation.tsx', readFileSync(new URL('../src/AppNavigation.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const frame = source.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'AppFrame')!;
  for (const os of ['android', 'ios', 'web']) {
    const host = layout(os, top), child = host.render({ children: 'form', busy: false });
    const env = { React, View: 'View', SafeAreaView: 'SafeAreaView', StatusBar: 'StatusBar', KeyboardAvoidingView: host.KAV, Platform: { OS: os }, useUI: () => ({ palette: {}, dark: false }) };
    const render = new Function('env', `with(env){${ts.transpileModule(frame.getText(source).replace(/^export /, ''), { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText};return AppFrame;}`)(env);
    const tree = render({ children: child });
    assert.ok(nodes(tree).find(n => n.type === 'SafeAreaView')!.props.edges.includes('top'));
    const active = nodes(tree).filter(n => n.type === host.KAV && n.props.behavior);
    assert.equal(active.length, os === 'web' ? 0 : 1, 'Avoid stacking Android and iOS keyboard adjustments');
    if (os === 'android') assert.equal(active[0].props.keyboardVerticalOffset, top, 'Account for the safe-area owning ancestor');
  }
});
