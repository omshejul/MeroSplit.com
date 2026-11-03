import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { withSharedUI } from './componentHarness.ts';
const nodes = (tree: any): any[] => Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === 'object' ? [tree, ...(tree.children ?? []).flat(Infinity).flatMap(nodes)] : [];
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function fixture() {
  const state: any[] = []; let cursor = 0, nextId = 0;
  const env = withSharedUI({ React: { Fragment: 'Fragment', createElement: (type: any, props: any, ...children: any[]) => ({ type, props: props ?? {}, children }) },
    Text: 'Text', KeyboardDialog: 'KeyboardDialog', Dialog: { Title: 'Dialog.Title', Actions: 'Dialog.Actions' }, Keyboard: { dismiss() {} }, Crypto: { randomUUID: () => `command-${++nextId}` }, useUI: () => ({ ui: {} }),
    useState: (initial: any) => { const id = cursor++; if (!(id in state)) state[id] = initial; return [state[id], (value: any) => state[id] = value]; },
    useRef: (initial: any) => { const id = cursor++; return state[id] ??= { current: initial }; },
  });
  const source = ts.createSourceFile('EditableName.tsx', readFileSync(new URL('../src/EditableName.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const body = source.statements.filter(n => !ts.isImportDeclaration(n) && !ts.isExportDeclaration(n)).map(n => n.getText(source).replace(/^export (?:default )?/, '')).join('\n');
  const render = new Function('env', `with(env){${ts.transpile(body, { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 })}; return EditableName;}`)(env);
  const props: any = { name: 'Goa trip', title: 'Group name', label: 'Edit group name', path: '/name', version: 3, busy: false, editable: true, onAction: async () => ({ id: 'group', version: 4 }) };
  return { props, render: () => { cursor = 0; return render(props); } };
}
const button = (tree: any, title: string) => nodes(tree).find(n => n.props.title === title);
const field = (tree: any) => nodes(tree).find(n => n.type === 'TextField');
function open(f: ReturnType<typeof fixture>) { nodes(f.render()).find(n => n.props.accessibilityLabel === 'Edit group name').props.onPress(); }

test('inline name opens its existing field dialog and submits one immutable rename', async () => {
  const f = fixture(), calls: any[] = []; let finish!: () => void;
  f.props.onAction = async (...args: any[]) => { calls.push(args); await new Promise<void>(resolve => finish = resolve); };
  open(f); f.props.version = 8; field(f.render()).props.onChangeText('  Weekend crew  ');
  const save = button(f.render(), 'Save').props.onPress; save(); save(); await tick();
  assert.equal(calls.length, 1); assert.deepEqual(calls[0], ['/name', { command_id: 'command-1', version: 3, name: 'Weekend crew' }]);
  assert.equal(button(f.render(), 'Saving…').props.disabled, true); finish(); await tick();
  assert.equal(nodes(f.render()).find(n => n.type === 'KeyboardDialog').props.visible, false);
});

test('failed nickname retains input, reports error and retries the same command', async () => {
  const f = fixture(), calls: any[] = []; f.props.allowEmpty = true; f.props.path = '/participants/person/nickname';
  f.props.onAction = async (...args: any[]) => { calls.push(args); if (calls.length === 1) throw Error('Connection interrupted'); return {}; };
  open(f); field(f.render()).props.onChangeText('Harry'); button(f.render(), 'Save').props.onPress(); await tick();
  assert.equal(field(f.render()).props.value, 'Harry'); assert.ok(nodes(f.render()).some(n => n.children.includes('Connection interrupted')));
  f.props.version = 8; button(f.render(), 'Save').props.onPress(); await tick(); assert.deepEqual(calls[1], calls[0]);
});

test('clearing a group nickname resets it, and read-only names expose no edit button', async () => {
  const f = fixture(); f.props.allowEmpty = true; let saved: any; f.props.onAction = async (_: any, body: any) => saved = body;
  open(f); field(f.render()).props.onChangeText(''); button(f.render(), 'Save').props.onPress(); await tick(); assert.equal(saved.name, '');
  f.props.editable = false; assert.ok(!nodes(f.render()).some(n => n.props.accessibilityLabel === 'Edit group name'));
});


test('losing edit permission keeps cancellation available while preventing a save', () => {
 const f = fixture(); open(f); field(f.render()).props.onChangeText('Changed'); f.props.editable = false;
 assert.equal(button(f.render(), 'Save').props.disabled, true);
 assert.equal(nodes(f.render()).find(n => n.type === 'CancelDialogActions').props.disabled, false);
 nodes(f.render()).find(n => n.type === 'CancelDialogActions').props.onCancel(); assert.equal(nodes(f.render()).find(n => n.type === 'KeyboardDialog').props.visible, false);
});
