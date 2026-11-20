import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = ts.createSourceFile('ScrollPrefetch.tsx', readFileSync(new URL('../src/ScrollPrefetch.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const code = ts.transpile(source.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(source).replace(/^export /, '')).join('\n'), { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React });
function trigger(enabled = true) {
  const viewport = { bottom: 700, listeners: new Set<() => void>() };
  const effects: (() => any)[] = [], refs: any[] = [];
  let callback: (...args: number[]) => void = () => {}, requests = 0, measurements = 0;
  const env = { React: { createElement: (type: any, props: any) => ({ type, props }) }, View: 'View', createContext: () => ({}), useContext: () => viewport, useRef: (current: any) => { const ref = { current }; refs.push(ref); return ref; }, useEffect: (effect: () => any) => effects.push(effect) };
  const component = new Function('env', `with(env){${code};return PrefetchTrigger;}`)(env);
  component({ enabled, onApproach: () => requests++ });
  refs[0].current = { measureInWindow: (done: typeof callback) => { measurements++; callback = done; } };
  const cleanup = effects[0]();
  return { viewport, check: () => viewport.listeners.forEach(check => check()), measure: (y: number, height = 1) => callback(0, y, 1, height), requests: () => requests, measurements: () => measurements, cleanup };
}

test('prefetch starts 600 points before the actual sheet end, once per batch without overlapping measurements', () => {
  const h = trigger();
  assert.equal(h.measurements(), 1);
  h.check(); h.check(); assert.equal(h.measurements(), 1);
  h.measure(1400); assert.equal(h.requests(), 0);
  h.check(); h.measure(1300); assert.equal(h.requests(), 1);
  h.check(); h.measure(1200); assert.equal(h.requests(), 1);
  h.cleanup(); assert.equal(h.viewport.listeners.size, 0);
});

test('closed sections, hidden markers and late measurements cannot append records', () => {
  const closed = trigger(false); assert.equal(closed.measurements(), 0); closed.cleanup();
  const hidden = trigger(); hidden.measure(0, 0); assert.equal(hidden.requests(), 0); hidden.cleanup();
  const removed = trigger(); removed.cleanup(); removed.measure(500); assert.equal(removed.requests(), 0);
});
