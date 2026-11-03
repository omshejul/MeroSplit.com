import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
function control(initial: boolean, os = 'native') {
  const values: any[] = [], effects: (() => void)[] = [], dependencies: any[][] = [];
  let cursor = 0;
  const React = { createElement: (type: any, props: any, ...children: any[]) => ({ type, props: props ?? {}, children }) };
  const source = ts.createSourceFile('NotificationSwitch.tsx', readFileSync(new URL('../src/NotificationSwitch.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const body = source.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(source).replace(/^export default /, '')).join('\n');
  const component = new Function('env', `with(env){${ts.transpile(body, { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React })}; return NotificationSwitch;}`)({ React, Platform: {OS:os}, View: 'View', Text: 'Text', Switch: 'Switch', Pressable: 'Pressable', ListRow: 'ListRow', Icon: 'Icon',
    useUI: () => ({ ui: {}, palette: { outline: '#888', switchOn: '#08f' } }),
    useState: (initial: any) => { const i = cursor++; if (!(i in values)) values[i] = initial; return [values[i], (value: any) => { values[i] = typeof value === 'function' ? value(values[i]) : value; }]; },
    useRef: (initial: any) => { const i = cursor++; return values[i] ??= { current: initial }; },
    useEffect: (effect: () => void, deps: any[]) => { const i = cursor++; if (!dependencies[i] || deps.some((v, j) => v !== dependencies[i][j])) { dependencies[i] = deps; effects.push(effect); } },
  });
  const calls: boolean[] = [];
  const props = { checked: initial, disabled: false, label: 'Email notifications', icon: 'mail', onChange: (value: boolean) => calls.push(value) };
  const render = () => { cursor = 0; const tree = component(props); effects.splice(0).forEach(fn => fn()); return tree; };
  return { render, calls, props };
}
function nodes(tree: any): any[] { return Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === 'object' ? [tree, ...(tree.children ?? []).flatMap(nodes), ...nodes(tree.props?.trailing), ...nodes(tree.props?.children)] : []; }
function switchValue(tree: any) { const row = nodes(tree).find(n => n.props?.accessibilityRole === 'switch'); return row?.props.accessibilityState.checked ?? nodes(tree).find(n => n.type === 'Switch')?.props.value; }
for (const initial of [true, false]) test(`the entire notification row toggles ${initial ? 'off' : 'on'} immediately while its parent is unchanged`, () => {
  const app = control(initial); let tree = app.render();
  const row = nodes(tree).find(n => n.props?.onPress);
  assert.ok(row, 'tapping the notification row must invoke its toggle');
  row.props.onPress(); tree = app.render();
  assert.equal(switchValue(tree), !initial, 'visible value must change before the parent/save returns');
  assert.deepEqual(app.calls, [!initial]);
  nodes(tree).find(n => n.props?.onPress).props.onPress();
  assert.equal(switchValue(app.render()), initial);
  assert.deepEqual(app.calls, [!initial, initial]);
});
test('disabled rows never change and later authoritative values reconcile the control', () => {
  const app = control(false); app.render(); app.props.disabled = true;
  const tree = app.render(); const row = nodes(tree).find(n => n.props?.onPress); row?.props.onPress();
  assert.deepEqual(app.calls, []); assert.equal(switchValue(app.render()), false);
  app.props.checked = true; app.render(); assert.equal(switchValue(app.render()), true);
});

test('Space toggles once, held keys do not repeat, and controlled security settings wait for their owner', () => {
 const app=control(false,'web');let tree=app.render(),prevented=0;
 nodes(tree).find(n=>n.props?.onKeyDown).props.onKeyDown({nativeEvent:{key:' ',repeat:false},preventDefault(){prevented++}});
 tree=app.render();assert.equal(switchValue(tree),true);assert.equal(prevented,1);
 nodes(tree).find(n=>n.props?.onKeyDown).props.onKeyDown({nativeEvent:{key:' ',repeat:true},preventDefault(){}});
 assert.deepEqual(app.calls,[true]);
 const controlled=control(false);Object.assign(controlled.props,{immediate:false});tree=controlled.render();nodes(tree).find(n=>n.props?.onPress).props.onPress();assert.equal(switchValue(controlled.render()),false);assert.deepEqual(controlled.calls,[true]);
});
