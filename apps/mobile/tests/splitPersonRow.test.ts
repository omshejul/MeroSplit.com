import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { validateExpense } from '../src/accounting.ts';
import { currencySymbol } from '../src/currency.ts';
import { withSharedUI } from './componentHarness.ts';

type Element = { type: any; props: any; children: any[] };
const React = { createElement: (type: any, props: any, ...children: any[]): Element => ({ type, props: props ?? {}, children }) };
const env = withSharedUI({ React, currencySymbol, View: 'View', Text: 'Text', Button: 'Button', Icon: 'Icon', Avatar: 'Avatar', TextField: 'TextField',
  StyleSheet: { create: (value: any) => value, hairlineWidth: 1 }, useUI: () => ({ ui: {}, palette: {} }) });
const source = ts.createSourceFile('SplitPersonRow.tsx', readFileSync(new URL('../src/SplitPersonRow.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const body = source.statements.filter(node => !ts.isImportDeclaration(node) && !ts.isExportDeclaration(node)).map(node => node.getText(source).replace(/^export (?:default )?/, '')).join('\n');
const { stepShare, SplitPersonRow } = new Function('env', `with(env){${ts.transpile(body, { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React })};return {stepShare,SplitPersonRow};}`)(env);
const nodes = (value: any): Element[] => Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object' && 'children' in value ? [value, ...value.children.flatMap(nodes)] : [];
const props = { person: { id: 'a', name: 'Anishk' }, title: 'Anishk', selected: true, disabled: false, editable: true, mode: 'shares', value: '1', onToggle() {}, onChange(_value: string) {} };
const action = (tree: any, label: string) => nodes(tree).find(node => node.props.accessibilityLabel === label)!;

test('share steps preserve exact fractions and large values, clamp zero, and reject malformed input', () => {
  for (const [value, delta, expected] of [['',1,'1'],['0',-1,'0'],['0.5',-1,'0'],['1.0001',1,'2.0001'],['2.0001',-1,'1.0001'],['9007199254740993.0001',1,'9007199254740994.0001'],['1.',1,'2']] as const) assert.equal(stepShare(value,delta),expected);
  for (const value of ['-1','abc','1,000','1.00001',' 1','1e3','0'.repeat(41)]) assert.equal(stepShare(value,1),null);
  assert.equal(stepShare('9'.repeat(40),1),null);
});

test('shares offer named increment/decrement controls and remain directly editable', () => {
  let value = '1.25';
  const render = () => SplitPersonRow({ ...props, value, onChange: (next: string) => value = next });
  action(render(),'Increase shares for Anishk').props.onPress(); assert.equal(value,'2.25');
  action(render(),'Decrease shares for Anishk').props.onPress(); assert.equal(value,'1.25');
  nodes(render()).find(node => node.type === 'TextField')!.props.onChangeText('0.0001'); assert.equal(value,'0.0001');
  action(render(),'Decrease shares for Anishk').props.onPress(); assert.equal(value,'0');
  for (const zero of ['', '0', '0.0', '0.0000']) assert.equal(action(SplitPersonRow({ ...props, value: zero }),'Decrease shares for Anishk').props.disabled,true);
});

test('unselected, busy, and removed members retain selection and edit locks', () => {
  let changes = 0;
  const tree = SplitPersonRow({ ...props, selected: false, onChange: () => changes++ });
  assert.equal(nodes(tree).find(node => node.type === 'TextField')!.props.editable,false);
  assert.equal(action(tree,'Increase shares for Anishk').props.disabled,true);
  for (const locked of [{ disabled:true, editable:false }, { disabled:false, editable:false }]) {
    const row = SplitPersonRow({ ...props, ...locked, onChange: () => changes++ });
    for (const direction of ['Increase','Decrease']) { const button=action(row,`${direction} shares for Anishk`);assert.equal(button.props.disabled,true);button.props.onPress(); }
    assert.equal(nodes(row).find(node => node.type === 'TextField')!.props.editable,false);
  }
  assert.equal(changes,0);
});

test('amount and percentage fields use one labeled inline input, without share buttons', () => {
  for (const [mode,label] of [['exact',`Anishk (${currencySymbol()})`],['percent','Anishk (%)']] as const) {
    let value=''; const tree=SplitPersonRow({ ...props, mode, onChange:(next:string)=>value=next });
    const input=nodes(tree).find(node=>node.type==='TextField')!;assert.equal(input.props.label,label);assert.equal(input.props.hideLabel,true);assert.equal(input.props.keyboardType,'decimal-pad');
    input.props.onChangeText('25.5');assert.equal(value,'25.5');
    assert.equal(nodes(tree).filter(node=>node.props.accessibilityLabel?.includes('shares for')).length,0);
  }
});

test('stepping shares feeds existing exact accounting and accepts individual zero shares', () => {
  let value='1'; const paid={a:'120000'},ids=['a','b'];
  const shares=()=>validateExpense('120000',paid,{mode:'shares',values:{a:value,b:'1'}},ids).shares;
  assert.deepEqual(shares(),{a:'60000',b:'60000'});
  action(SplitPersonRow({ ...props, value, onChange:(next:string)=>value=next }),'Increase shares for Anishk').props.onPress();
  assert.deepEqual(shares(),{a:'80000',b:'40000'});
  value=stepShare(stepShare(value,-1),-1);assert.deepEqual(shares(),{a:'0',b:'120000'});
});

test('adjustment sign control works with the decimal keyboard and respects edit locks', () => {
  let value = '20';
  const render = (extra = {}) => SplitPersonRow({ ...props, mode: 'adjustment', value, onChange: (next: string) => value = next, ...extra });
  action(render(), 'Switch to subtract for Anishk').props.onPress(); assert.equal(value, '-20');
  let input = nodes(render()).find(node => node.type === 'TextField')!;
  assert.equal(input.props.value, '20'); assert.equal(input.props.label, 'Adjustment for Anishk (₹)');
  input.props.onChangeText('25.50'); assert.equal(value, '-25.50');
  action(render(), 'Switch to add for Anishk').props.onPress(); assert.equal(value, '25.50');
  const locked = action(render({ editable: false }), 'Switch to subtract for Anishk');
  assert.equal(locked.props.disabled, true); locked.props.onPress(); assert.equal(value, '25.50');
});
