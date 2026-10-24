import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as members from '../src/members.ts';
import type { Group } from '../src/types.ts';

type Element = { type: any; props: Record<string, any>; children: any[] };
const nodes = (value: any): Element[] => Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object' && 'children' in value ? [value, ...value.children.flatMap(nodes)] : [];
const component = (tree: any, name: string) => nodes(tree).find(node => node.type === name || node.type?.name === name)!;
const button = (tree: any, title: string) => nodes(tree).find(node => node.props.title === title)!;
const tick = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

function production(file: string, extra: Record<string, any> = {}) {
  let cursor = 0, nextId = 0;
  const states: any[] = [], dependencies: Record<number, any[]> = {}, cleanups: Record<number, any> = {}, timers = new Map<number, () => void>();
  let effects: (() => void)[] = [];
  const env: Record<string, any> = {
    ...members, React: { Fragment: 'Fragment', createElement: (type: any, props: any, ...children: any[]) => ({ type, props: props ?? {}, children }) },
    Platform: { OS: 'native' }, View: 'View', Text: 'Text', Pressable: 'Pressable', Button: 'Button', Avatar: 'Avatar', Icon: 'Icon', IconAction: 'IconAction',
    Disclosure: 'Disclosure', EmailField: 'EmailField', TextField: 'TextField', GroupMembershipActions: 'GroupMembershipActions', KeyboardDialog: 'KeyboardDialog', SendInviteDialog: 'SendInviteDialog',
    DialogFocus: 'DialogFocus', DialogScrollBody: 'DialogScrollBody', CancelDialogActions: 'CancelDialogActions', ErrorText: 'ErrorText', Dialog: Object.assign(() => {}, { Title: 'Dialog.Title' }),
    Keyboard: { dismiss() {} }, StyleSheet: { create: (value: any) => value, hairlineWidth: 1 }, Crypto: { randomUUID: () => `id-${++nextId}` }, useUI: () => ({ ui: {}, palette: {} }),
    requestAnimationFrame: (callback: () => void) => { callback(); return 1; }, cancelAnimationFrame() {},
    setTimeout: (callback: () => void) => { const id = ++nextId; timers.set(id, callback); return id; }, clearTimeout: (id: number) => timers.delete(id),
    useState: (initial: any) => { const id = cursor++; if (!(id in states)) states[id] = initial; return [states[id], (value: any) => { states[id] = typeof value === 'function' ? value(states[id]) : value; }]; },
    useRef: (initial: any) => { const id = cursor++; return states[id] ??= { current: initial }; },
    useEffect: (fn: () => any, values: any[]) => { const id = cursor++; if (!dependencies[id] || values.some((value, i) => value !== dependencies[id][i])) { effects.push(() => { cleanups[id]?.(); cleanups[id] = fn(); }); dependencies[id] = values; } },
    ...extra,
  };
  const source = ts.createSourceFile(file, readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const body = source.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(source).replace(/^export (?:default )?/, '')).join('\n');
  const names = source.statements.filter(ts.isFunctionDeclaration).map(node => node.name?.text).filter(Boolean);
  const code = ts.transpile(body, { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React });
  const functions = new Function('env', `with(env){${code}; return {${names.join(',')}};}`)(env);
  return {
    render(name: string, props: any): Element { cursor = 0; return functions[name](props); },
    async commit() { const pending = effects; effects = []; pending.forEach(fn => fn()); await tick(); },
    timer() { const pending = [...timers.values()]; timers.clear(); pending.forEach(fn => fn()); },
    unmount() { Object.values(cleanups).forEach(fn => fn?.()); },
  };
}

function settings(linked = false, deliver?: (path: string, body: Record<string, unknown>) => Promise<Record<string, unknown>>) {
  const group: Group = { id: 'group', name: 'Trip', owner_id: 1, version: 1, participants: [{ id: 'self', name: 'You', user_id: 1 }], expenses: [], settlements: [], balances: {}, transfers: [], activity: [] };
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const app = production('MembersScreen.tsx');
  let addPersonRequest = 0;
  const props = { group, selfId: 'self', busy: false, onMembership() {}, onAction: async (path: string, body: Record<string, unknown>) => {
    calls.push({ path, body });
    if (path === '/participants') {
      group.participants.push({ id: String(body.id), name: String(body.name), email: String(body.email), user_id: linked ? 2 : null });
      return { id: group.id, version: ++group.version, linked_participant_ids: linked ? [body.id] : [] };
    }
    return deliver ? deliver(path, body) : { id: group.id, version: ++group.version, linked_participant_ids: [], invite: { id: body.command_id, state: 'sent', retry_after: 60 } };
  } };
  const render = () => app.render('MemberSettings', { ...props, addPersonRequest });
  return { ...app, group, calls, render, async add(email = 'noor@example.invalid') {
    render(); await app.commit(); addPersonRequest++; render(); await app.commit();
    let tree = render(), dialog = component(tree, 'AddPersonDialog'); dialog.props.onName('Noor'); dialog.props.onEmail(email);
    tree = render(); dialog = component(tree, 'AddPersonDialog'); dialog.props.onSave(); dialog.props.onSave(); await tick();
    tree = render(); await app.commit(); return tree;
  } };
}

test('Add person closes for linked accounts and name-only contacts, without a success caption or an email request', async () => {
  for (const [linked, email] of [[true, 'noor@example.invalid'], [false, '']] as const) {
    const app = settings(linked);
    try {
      const tree = await app.add(email);
      assert.equal(component(tree, 'AddPersonDialog').props.visible, false);
      assert.equal(component(tree, 'SendInviteDialog').props.visible, false);
      assert.equal(app.calls.length, 1, 'duplicate Add taps must use one accepted command');
      assert.equal(nodes(tree).some(node => node.props.feedback?.text.includes('Person added')), false);
    } finally { app.unmount(); }
  }
});

test('An unknown email gets an explicit confirmation; Cancel keeps the already accepted person and sends nothing', async () => {
  const app = settings();
  try {
    let tree = await app.add(' Noor@Example.invalid ');
    const prompt = component(tree, 'SendInviteDialog');
    assert.equal(prompt.props.visible, true); assert.equal(prompt.props.email, 'noor@example.invalid');
    assert.equal(app.calls.length, 1); assert.equal(app.group.participants.length, 2);
    prompt.props.onCancel(); tree = app.render(); await app.commit();
    assert.equal(component(tree, 'SendInviteDialog').props.visible, false);
    assert.equal(app.calls.length, 1); assert.equal(app.group.participants[1].email, 'noor@example.invalid');
  } finally { app.unmount(); }
});

test('Confirmed Send runs once and closes quietly for either accepted delivery or a newly existing account', async () => {
  for (const linked of [false, true]) {
    const app = settings(false, async (_path, body) => ({ id: 'group', version: 3, linked_participant_ids: linked ? [app.group.participants[1].id] : [],
      ...(!linked && { invite: { id: body.command_id, state: 'sent', retry_after: 60 } }) }));
    try {
      let tree = await app.add(), prompt = component(tree, 'SendInviteDialog');
      prompt.props.onSend(); prompt.props.onSend(); await tick(); tree = app.render(); await app.commit();
      assert.equal(app.calls.length, 2); assert.match(app.calls[1].path, /\/email-invite$/);
      assert.equal(component(tree, 'SendInviteDialog').props.visible, false);
      assert.equal(component(tree, 'SendInviteDialog').props.error, '');
    } finally { app.unmount(); }
  }
});

test('Uncertain sends retain their command and cooldown without an automatic retry or countdown label', async () => {
  let fail = true;
  const app = settings(false, async (_path, body) => {
    if (fail) throw new Error('Connection lost. Press Send to check.');
    return { id: 'group', version: 3, linked_participant_ids: [], invite: { id: body.command_id, state: 'sent', retry_after: 60 } };
  });
  try {
    let tree = await app.add(); component(tree, 'SendInviteDialog').props.onSend(); await tick(); tree = app.render(); await app.commit();
    assert.equal(component(tree, 'SendInviteDialog').props.visible, true);
    assert.match(component(tree, 'SendInviteDialog').props.error, /Connection lost/);
    component(tree, 'SendInviteDialog').props.onSend(); tree = app.render(); await app.commit(); assert.equal(app.calls.length, 2);
    for (let i = 0; i < 60; i++) { app.timer(); tree = app.render(); await app.commit(); }
    assert.equal(app.calls.length, 2, 'cooldown expiry must not deliver automatically');
    fail = false; component(tree, 'SendInviteDialog').props.onSend(); await tick(); tree = app.render();
    assert.equal(app.calls.length, 3); assert.deepEqual(app.calls[1], app.calls[2]);
    assert.equal(component(tree, 'SendInviteDialog').props.visible, false);
  } finally { app.unmount(); }
});

test('Reusable invitation dialog wraps the full email and keeps Send, Cancel, error and busy boundaries explicit', async () => {
  const app = production('SendInviteDialog.tsx'); let sends = 0, cancels = 0;
  const props = { visible: true, email: 'very.long.recipient.name@example.invalid', busy: false, error: 'Check your connection, then press Send.', onSend: () => sends++, onCancel: () => cancels++ };
  try {
    const tree = app.render('SendInviteDialog', props); await app.commit();
    assert.equal(component(tree, 'KeyboardDialog').props.dismissable, true);
    const body = nodes(tree).find(node => node.type === 'Text')!;
    assert.equal(body.children.join(''), `${props.email} isn't on MeroSplit yet. Send them an invite?`);
    assert.equal(body.props.numberOfLines, undefined, 'long email must wrap');
    assert.equal(component(tree, 'ErrorText').children[0], props.error);
    button(tree, 'Send').props.onPress(); component(tree, 'CancelDialogActions').props.onCancel(); assert.equal(sends, 1); assert.equal(cancels, 1);
    const busy = app.render('SendInviteDialog', { ...props, busy: true }); await app.commit();
    assert.equal(button(busy, 'Sending').props.disabled, true); assert.equal(component(busy, 'CancelDialogActions').props.disabled, true);
    component(busy, 'KeyboardDialog').props.onDismiss(); assert.equal(cancels, 1);
    assert.equal(component(busy, 'KeyboardDialog').props.dismissable, false);
  } finally { app.unmount(); }
});

test('Member invitation buttons remain Send or Sending through cooldown and delivery states', () => {
  const app = production('MembersScreen.tsx'), group: Group = { id: 'group', name: 'Trip', owner_id: 1, version: 1, participants: [], expenses: [], settlements: [], balances: {}, transfers: [], activity: [] };
  const person = { id: 'person', name: 'Noor', email: 'noor@example.invalid', user_id: null };
  for (const state of ['sent', 'failed', 'sending']) {
    group.invites = [{ id: 'invite', participant_id: person.id, intended_email: person.email, send_state: state, approved: false, revoked: false, claimant_id: null, claimant_email: null }];
    for (const cooldown of [0, 60]) {
      const tree = app.render('MemberRow', { group, person, selfId: 'self', organizer: true, disabled: false, working: false, feedback: null, cooldown, contactChanged: false });
      assert.equal(button(tree, 'Send').props.disabled, cooldown > 0);
      assert.equal(nodes(tree).some(node => node.type === 'Text' && node.children.includes('Invited')), false);
    }
  }
  const tree = app.render('MemberRow', { group, person, selfId: 'self', organizer: true, disabled: true, working: true, feedback: { section: 'email-invite:person', text: '', error: false }, cooldown: 60, contactChanged: false });
  assert.equal(button(tree, 'Sending').props.disabled, true);
});
