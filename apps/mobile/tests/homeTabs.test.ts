import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

function swipeHarness() {
  const state = { selected: 'Groups', busy: false, motion: true, focused: false, rtl: false };
  const selected: string[] = [], positions: number[] = [], refs: any[] = []; let cursor = 0, handlers: any;
  const animated = { stopAnimation() {}, setValue(value: number) { positions.push(value); } };
  const file = ts.createSourceFile('swipe.ts', readFileSync(new URL('../src/useHomeTabSwipe.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
  const body = file.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(file).replace(/^export /, '')).join('\n');
  const useSwipe = new Function('env', `with(env){${ts.transpile(body, { target: ts.ScriptTarget.ES2022 })};return useHomeTabSwipe;}`)({
    useRef: (initial: unknown) => refs[cursor++] ??= { current: initial }, useState: () => [animated], useLayoutEffect() {},
    useMemo: (fn: () => unknown) => fn(), useWindowDimensions: () => ({ width: 390 }), useUI: () => ({ motion: { enabled: state.motion } }),
    Animated: { Value: class {}, timing: (_value: any, options: any) => ({ start() { animated.setValue(options.toValue); } }) },
    Platform: { OS: 'ios' }, I18nManager: { get isRTL() { return state.rtl; } },
    TextInput: { State: { currentlyFocusedInput: () => state.focused ? {} : null } },
    PanResponder: { create: (value: unknown) => { handlers = value; return { panHandlers: value }; } },
  });
  const render = () => { cursor = 0; useSwipe(state.selected, state.busy, (tab: string) => selected.push(tab)); };
  render();
  return { state, selected, positions, render, handlers: () => handlers, gesture: (changes = {}) => ({ dx: -120, dy: 3, vx: -0.7, x0: 200, numberActiveTouches: 1, ...changes }) };
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
    const app = swipeHarness(); app.handlers().onStartShouldSetPanResponderCapture();
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
