import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const nativeRequire = createRequire(require.resolve('react-native/package.json'));
const babel = nativeRequire('@babel/core');
function actualPanResponder() {
  const load = (name: string): any => {
    const filename = nativeRequire.resolve(`./Libraries/Interaction/${name}.js`);
    const code = babel.transformSync(readFileSync(filename, 'utf8'), { filename, babelrc: false, configFile: false, plugins: [nativeRequire.resolve('babel-plugin-syntax-hermes-parser'), nativeRequire.resolve('@babel/plugin-transform-flow-strip-types'), nativeRequire.resolve('@babel/plugin-transform-modules-commonjs')] }).code;
    const module = { exports: {} as any };
    new Function('require', 'module', 'exports', code)((name: string) => { assert.equal(name, './TouchHistoryMath'); return load('TouchHistoryMath'); }, module, module.exports);
    return module.exports;
  };
  return load('PanResponder').default;
}

function swipeHarness(real = false) {
  const state = { selected: 'Groups', busy: false, motion: true, focused: false, rtl: false, os: 'ios' };
  const selected: string[] = [], positions: number[] = [], refs: any[] = []; let cursor = 0, handlers: any, nativeHandlers: any;
  const animated = { stopAnimation() {}, setValue(value: number) { positions.push(value); } };
  const file = ts.createSourceFile('swipe.ts', readFileSync(new URL('../src/useHomeTabSwipe.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
  const body = file.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(file).replace(/^export /, '')).join('\n');
  const useSwipe = new Function('env', `with(env){${ts.transpile(body, { target: ts.ScriptTarget.ES2022 })};return useHomeTabSwipe;}`)({
    useRef: (initial: unknown) => refs[cursor++] ??= { current: initial }, useState: () => [animated], useLayoutEffect() {},
    useMemo: (fn: () => unknown) => fn(), useWindowDimensions: () => ({ width: 390 }), useUI: () => ({ motion: { enabled: state.motion } }),
    Animated: { Value: class {}, timing: (_value: any, options: any) => ({ start() { animated.setValue(options.toValue); } }) },
    Platform: { get OS() { return state.os; } }, I18nManager: { get isRTL() { return state.rtl; } },
    TextInput: { State: { currentlyFocusedInput: () => { assert.equal(state.os, 'ios'); return state.focused ? {} : null; }, currentlyFocusedField: () => { assert.equal(state.os, 'web'); return state.focused ? {} : null; } } },
    PanResponder: { create: (value: unknown) => { handlers = value; if (!real) { const start = handlers.onStartShouldSetPanResponderCapture; handlers.onStartShouldSetPanResponderCapture = (event = { nativeEvent: { pageX: 200, touches: [{ pageX: 200 }] } }) => start(event); } const result = real ? actualPanResponder().create(value) : { panHandlers: value }; nativeHandlers = result.panHandlers; return result; } },
  });
  const render = () => { cursor = 0; useSwipe(state.selected, state.busy, (tab: string) => selected.push(tab)); };
  render();
  return { state, selected, positions, render, handlers: () => handlers, nativeHandlers: () => nativeHandlers, gesture: (changes = {}) => ({ dx: -120, dy: 3, vx: -0.7, x0: 0, numberActiveTouches: 1, ...changes }) };
}

test('home swipes move to adjacent tabs without wrapping; taps remain an equivalent action', () => {
  const app = swipeHarness(), h = app.handlers(); h.onStartShouldSetPanResponderCapture();
  assert.equal(h.onMoveShouldSetPanResponderCapture(null, app.gesture()), true);
  h.onPanResponderRelease(null, app.gesture()); assert.deepEqual(app.selected, ['Friends']);
  app.state.selected = 'Account'; app.render();
  assert.equal(app.handlers().onMoveShouldSetPanResponderCapture(null, app.gesture()), false);
  app.state.selected = 'Groups'; app.render();
  assert.equal(app.handlers().onMoveShouldSetPanResponderCapture(null, app.gesture({ dx: 120 })), false);
});

test('vertical/diagonal scrolling, editing, multiple fingers and native edge-back gestures are not claimed', () => {
  for (const change of [{ dy: 120, dx: 3 }, { dy: 90 }, { numberActiveTouches: 2 }, { x0: 10 }, { x0: 385 }]) {
    const app = swipeHarness(); app.handlers().onStartShouldSetPanResponderCapture({ nativeEvent: { pageX: change.x0 ?? 200, touches: [{ pageX: change.x0 ?? 200 }] } });
    assert.equal(app.handlers().onMoveShouldSetPanResponderCapture(null, app.gesture(change)), false);
  }
  const app = swipeHarness(); app.state.focused = true; app.render();
  assert.equal(app.handlers().onMoveShouldSetPanResponderCapture(null, app.gesture()), false);
  app.state.focused = false; app.state.busy = true; app.render();
  assert.equal(app.handlers().onMoveShouldSetPanResponderCapture(null, app.gesture()), false);
  app.state.busy = false; app.render(); app.handlers().onStartShouldSetPanResponderCapture();
  app.handlers().onMoveShouldSetPanResponderCapture(null, app.gesture({ dx: 2, dy: 25 }));
  assert.equal(app.handlers().onMoveShouldSetPanResponderCapture(null, app.gesture()), false);
});

test('short/cancelled swipes stay put; a route change or busy work cancels the navigation', () => {
  const app = swipeHarness(), h = app.handlers(); h.onStartShouldSetPanResponderCapture();
  h.onPanResponderRelease(null, app.gesture({ dx: -25, vx: 0 }));
  h.onPanResponderMove(null, app.gesture()); h.onPanResponderTerminate();
  assert.equal(app.positions.at(-1), 0); assert.deepEqual(app.selected, []);
  app.state.selected = 'Activity'; app.render();
  app.handlers().onPanResponderRelease(null, app.gesture()); assert.deepEqual(app.selected, []);
  app.handlers().onStartShouldSetPanResponderCapture(); app.state.busy = true; app.render();
  app.handlers().onPanResponderRelease(null, app.gesture()); assert.deepEqual(app.selected, []);
});

test('reduced motion keeps navigation without moving content; RTL follows reading direction', () => {
  const app = swipeHarness(); app.state.motion = false; app.state.rtl = true; app.render();
  const h = app.handlers(), gesture = app.gesture({ dx: 120, vx: 0.8 }); h.onStartShouldSetPanResponderCapture();
  assert.equal(h.onMoveShouldSetPanResponderCapture(null, gesture), true);
  h.onPanResponderMove(null, gesture); assert.deepEqual(app.positions, []);
  h.onPanResponderRelease(null, gesture); assert.deepEqual(app.selected, ['Friends']);
});

test('native tab changes keep routes authoritative and never mount four account surfaces', () => {
  const React = { createElement: (type: unknown, props: any, ...children: any[]) => ({ type, props, children }) };
  const file = ts.createSourceFile('HomeTabs.ios.tsx', readFileSync(new URL('../src/HomeTabs.ios.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const body = file.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(file).replace(/^export (?:default )?/, '')).join('\n');
  const refs = { current: 0 }, selected: string[] = [], rendered: string[] = [];
  const render = new Function('env', `with(env){${ts.transpile(body, { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React })};return HomeTabs;}`)({
    React, Platform: { Version: '27' }, Tabs: { Host: 'NativeTabs', Screen: 'NativeTab' }, Animated: { View: 'AnimatedView' },
    useRef: () => refs, useUI: () => ({ palette: { accent: 'accent', background: 'background' }, dark: true }), useHomeTabSwipe: () => ({}),
  });
  const props = { selected: 'Groups', busy: false, onSelect: (value: string) => selected.push(value), render: (value: string) => { rendered.push(value); return value; } };
  const tree = render(props); assert.equal(tree.type, 'NativeTabs'); assert.deepEqual(rendered, ['Groups']);
  tree.props.onTabSelected({ nativeEvent: { provenance: 4, selectedScreenKey: 'Friends', actionOrigin: 'user' } });
  assert.deepEqual(selected, ['Friends']); assert.equal(refs.current, 4);
  tree.props.onTabSelected({ nativeEvent: { provenance: 5, selectedScreenKey: 'Activity', actionOrigin: 'programmatic-js' } });
  assert.deepEqual(selected, ['Friends']);
  const busy = render({ ...props, busy: true }); assert.ok(busy.children[0].every((node: any) => node.props.preventNativeSelection));
  busy.props.onTabSelected({ nativeEvent: { provenance: 6, selectedScreenKey: 'Account', actionOrigin: 'user' } });
  assert.deepEqual(selected, ['Friends']);
});

test('web uses its supported input focus API so text editing never changes tabs', () => {
  const app = swipeHarness(); app.state.os = 'web'; app.render();
  app.handlers().onStartShouldSetPanResponderCapture();
  assert.equal(app.handlers().onMoveShouldSetPanResponderCapture(null, app.gesture()), true);
  app.state.focused = true; app.render();
  assert.equal(app.handlers().onMoveShouldSetPanResponderCapture(null, app.gesture()), false);
});

// Exercise the installed RN lifecycle, including x0 remaining zero until grant.
test('real React Native responder claims a root swipe before x0 is initialized', () => {
  const app = swipeHarness(true), h = app.nativeHandlers();
  const touch: any = { touchActive: true, startPageX: 200, startPageY: 200, startTimeStamp: 1, previousPageX: 200, previousPageY: 200, previousTimeStamp: 1, currentPageX: 200, currentPageY: 200, currentTimeStamp: 1 };
  const history = { touchBank: [touch], numberActiveTouches: 1, indexOfSingleActiveTouch: 0, mostRecentTimeStamp: 1 };
  const event = () => ({ nativeEvent: { pageX: touch.currentPageX, pageY: touch.currentPageY, touches: history.numberActiveTouches ? [{ pageX: touch.currentPageX, pageY: touch.currentPageY }] : [] }, touchHistory: history });
  assert.equal(h.onStartShouldSetResponderCapture(event()), false);
  touch.currentPageX = 170; touch.currentTimeStamp = 2; history.mostRecentTimeStamp = 2;
  assert.equal(h.onMoveShouldSetResponderCapture(event()), true, 'the native responder still has x0=0 here');
  h.onResponderGrant(event());
  touch.previousPageX = 170; touch.previousTimeStamp = 2; touch.currentPageX = 70; touch.currentTimeStamp = 3; history.mostRecentTimeStamp = 3;
  h.onResponderMove(event()); touch.touchActive = false; history.numberActiveTouches = 0; h.onResponderEnd(event()); h.onResponderRelease(event());
  assert.deepEqual(app.selected, ['Friends']);
});
