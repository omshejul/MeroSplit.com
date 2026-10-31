import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { keyboardScrollDelta } from '../src/keyboardVisibility.ts';

test('focus visibility clips to the usable viewport and moves only the required distance', () => {
  assert.equal(keyboardScrollDelta(100, 500, 200, 48), 0);
  assert.equal(keyboardScrollDelta(100, 500, 470, 48), 30);
  assert.equal(keyboardScrollDelta(100, 500, 80, 48), -32);
  assert.equal(keyboardScrollDelta(100, 500, 112, 376), 0);
  assert.equal(keyboardScrollDelta(100, 500, 112, 600), 224);
  assert.equal(keyboardScrollDelta(100, 500, -112, 600), 0, 'oversized input stays stable after bottom alignment');
  assert.equal(keyboardScrollDelta(100, 100, 200, 48), 0);
});

// Run the production controller with native measurement callbacks we can defer.
// Device probes separately cover the actual IME and layout engine.
function scroller(os = 'android') {
  const source = ts.createSourceFile('KeyboardScrollView.tsx', readFileSync(new URL('../src/KeyboardScrollView.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const fn = source.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'KeyboardScrollView')!;
  let cursor = 0, sequence = 0, keyboardTop: number | undefined = 400;
  const slots: any[] = [], frames = new Map<number, Function>(), timers = new Map<number, Function>(), listeners = new Map<string, Function>();
  const effects: Function[] = [], cleanup: Function[] = [], scrolls: number[] = [];
  let provider: any, scrollProps: any, measure: Function = (done: Function) => done(0, 100, 360, 600);
  const node = { measureInWindow(done: Function) { measure(done); }, scrollTo({ y }: { y: number }) { scrolls.push(y); } };
  const useRef = (value: unknown) => { const i = cursor++; return slots[i] ??= { current: value }; };
  const useState = (value: unknown) => { const i = cursor++; if (!(i in slots)) slots[i] = value; return [slots[i], (next: any) => { slots[i] = typeof next === 'function' ? next(slots[i]) : next; }]; };
  const useMemo = (fn: Function, deps: unknown[]) => { const i = cursor++; if (!slots[i] || deps.some((v, n) => v !== slots[i].deps[n])) slots[i] = { deps, value: fn() }; return slots[i].value; };
  const React = {
    useImperativeHandle(ref: any, value: Function) { if (ref) effects.push(() => { ref.current = value(); }); },
    createElement(type: string, props: any, ...children: any[]) {
      if (type === 'ScrollView') { scrollProps = props; props.ref.current = node; }
      if (type === 'Provider') provider = props.value;
      return { type, props, children };
    },
  };
  const env = { React, useRef, useState, useMemo, useCallback: (fn: Function, deps: unknown[]) => useMemo(() => fn, deps),
    useEffect(fn: Function) { const i = cursor++; if (!slots[i]) { slots[i] = true; effects.push(() => cleanup.push(fn())); } },
    KeyboardVisibility: { Provider: 'Provider' }, ScrollView: 'ScrollView', Platform: { OS: os }, StyleSheet: { flatten: (style: any) => style },
    Keyboard: { metrics: () => keyboardTop === undefined ? undefined : { screenY: keyboardTop }, addListener: (name: string, fn: Function) => { listeners.set(name, fn); return { remove() { listeners.delete(name); } }; } },
    keyboardScrollDelta,
    setTimeout(fn: Function) { timers.set(++sequence, fn); return sequence; }, clearTimeout(id: number) { timers.delete(id); },
    requestAnimationFrame(fn: Function) { frames.set(++sequence, fn); return sequence; }, cancelAnimationFrame(id: number) { frames.delete(id); },
  };
  const renderFn = new Function('env', `with(env) { ${ts.transpile(fn.getText(source).replace('export default ', ''), { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 })}; return KeyboardScrollView; }`)(env);
  return {
    scrolls, node, get controller() { return provider; }, get props() { return scrollProps; },
    render(props: any = {}) { cursor = 0; const tree = renderFn(props); effects.splice(0).forEach(fn => fn()); return tree; },
    flush() { const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn()); },
    settle() { const pending = [...timers.values()]; timers.clear(); pending.forEach(fn => fn()); },
    event(name: string) { listeners.get(name)?.(); },
    keyboard(top?: number) { keyboardTop = top; },
    measureWith(fn: Function) { measure = fn; },
    unmount() { cleanup.forEach(fn => fn?.()); },
  };
}
function input(y: number, height = 48) { return { isFocused: () => true, measureInWindow(done: Function) { done(0, y, 300, height); } }; }

test('keyboard overlay, focus switching without a keyboard event, refs and caller handlers', () => {
  const s = scroller(), ref: any = { current: null }; let layouts = 0, sizes = 0, scrollEvents = 0;
  const props = { ref, contentContainerStyle: { padding: 16 }, onLayout: () => layouts++, onContentSizeChange: () => sizes++, onScroll: () => scrollEvents++ };
  s.render(props); assert.equal(ref.current, s.node);
  s.props.onScroll({ nativeEvent: { contentOffset: { y: 100 } } });
  s.controller.focus(input(380)); s.flush(); assert.deepEqual(s.scrolls, [140]);
  s.render(props); assert.equal(s.props.contentContainerStyle[1].paddingBottom, 328);
  s.controller.focus(input(90)); s.flush(); assert.equal(s.scrolls.at(-1), 78);
  s.props.onLayout({}); s.props.onContentSizeChange(300, 900); s.flush();
  assert.equal(layouts, 1); assert.equal(sizes, 1); assert.equal(scrollEvents, 1);
  s.keyboard(); s.event('keyboardDidHide'); s.flush(); s.render(props);
  assert.equal(s.props.contentContainerStyle[1], false);
  s.unmount();
});

test('old blur, deferred measurements, manual dragging and unmount cannot move another input', () => {
  const s = scroller(); s.render(); const a = input(380), b = input(200); let pending: Function | undefined;
  s.measureWith((done: Function) => { pending = done; });
  s.controller.focus(a); s.flush(); s.controller.focus(b); s.controller.blur(a);
  pending!(0, 100, 300, 600); assert.equal(s.scrolls.length, 0);
  s.measureWith((done: Function) => done(0, 100, 300, 600)); s.flush(); assert.equal(s.scrolls.length, 0);
  s.props.onScrollBeginDrag({}); s.event('keyboardDidShow'); s.flush(); assert.equal(s.scrolls.length, 0);
  s.controller.focus(a); s.flush(); assert.equal(s.scrolls.length, 1);
  s.controller.changed(); s.unmount(); s.flush(); assert.equal(s.scrolls.length, 1);
});

test('iOS sheet-window coordinates use the resized container rather than screen keyboard coordinates', () => {
  const s = scroller('ios'); s.render(); s.keyboard(200);
  s.measureWith((done: Function) => done(0, 0, 360, 400));
  s.controller.focus(input(200)); s.flush(); assert.equal(s.scrolls.length, 0);
  s.controller.focus(input(380)); s.flush(); assert.equal(s.scrolls.at(-1), 40);
  s.unmount();
});

test('blurring before keyboard hide restores multiline expansion for the next field', () => {
  const s = scroller(), field = input(200); s.render(); s.controller.focus(field); s.flush(); s.render();
  assert.equal(s.controller.inputHeight, 276);
  s.controller.blur(field); s.keyboard(); s.event('keyboardDidHide'); s.flush(); s.render();
  assert.equal(s.controller.inputHeight, undefined);
  s.unmount();
});

test('the virtualized group scroller preserves pull-to-refresh and caller refresh controls', () => {
  const source = ts.createSourceFile('GroupScreen.tsx', readFileSync(new URL('../src/GroupScreen.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let renderer: ts.JsxExpression | undefined;
  function visit(node: ts.Node) { if (ts.isJsxAttribute(node) && node.name.getText(source) === 'renderScrollComponent') renderer = node.initializer as ts.JsxExpression; ts.forEachChild(node, visit); }
  visit(source); assert.ok(renderer?.expression);
  let refreshed = 0;
  const onRefresh = () => refreshed++;
  const React = { createElement: (type: unknown, props: any) => ({ type, props }) };
  const render = new Function('React', 'KeyboardScrollView', 'RefreshControl', 'onRefresh', 'refreshing', `${ts.transpile('const renderer = ' + renderer.expression.getText(source), { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 })}; return renderer;`)(React, 'KeyboardScrollView', 'RefreshControl', onRefresh, true);
  const result = render({ onScroll: 'preserved' });
  assert.equal(result.props.onScroll, 'preserved');
  assert.equal(result.props.refreshControl.type, 'RefreshControl'); assert.equal(result.props.refreshControl.props.refreshing, true);
  result.props.refreshControl.props.onRefresh(); assert.equal(refreshed, 1);
  const custom = {}; assert.equal(render({ refreshControl: custom }).props.refreshControl, custom);
});

// Android form-sheet presentation can finish after the IME notification.
test('focus is remeasured after a native sheet moves without a React layout event', () => {
  const s = scroller(); s.render(); let y = 380, top = 100;
  s.measureWith((done: Function) => done(0, top, 360, 500));
  s.props.onScroll({ nativeEvent: { contentOffset: { y: 100 } } });
  s.controller.focus({ isFocused: () => true, measureInWindow(done: Function) { done(0, y, 300, 48); } });
  s.flush(); assert.equal(s.scrolls.at(-1), 140);
  top = 140; y = 95; s.settle(); s.flush();
  assert.equal(s.scrolls.at(-1), 43, 'late presentation must reveal the field below the moved viewport top');
  s.unmount();
});
