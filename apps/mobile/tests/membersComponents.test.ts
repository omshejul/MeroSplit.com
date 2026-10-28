import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { confirmedGroupInvite } from '../src/appLinks.ts';
import { restartForUpdate } from '../src/appUpdate.ts';
import * as members from '../src/members.ts';
import type { Group } from '../src/types.ts';
import { ApiError } from '../src/api.ts';

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
    ...members, confirmedGroupInvite, copyText: async (value: string | Promise<string>) => { await value; }, React: { Fragment: 'Fragment', createElement: (type: any, props: any, ...children: any[]) => ({ type, props: props ?? {}, children }) },
    useToast: () => () => {}, PersonInviteDialog: 'PersonInviteDialog', DetailDialog: 'DetailDialog', __DEV__: false, SettingsRow: 'SettingsRow', Platform: { OS: 'native' }, View: 'View', Text: 'Text', Pressable: 'Pressable', Button: 'Button', Avatar: 'Avatar', Icon: 'Icon', IconAction: 'IconAction',
    Constants: { platform: { ios: { buildNumber: '27' }, android: { versionCode: 26 } } }, requireOptionalNativeModule: () => ({ nativeApplicationVersion: '1.2', nativeBuildVersion: '27' }),
    EmailField: 'EmailField', TextField: 'TextField', GroupMembershipActions: 'GroupMembershipActions', KeyboardDialog: 'KeyboardDialog', SendInviteDialog: 'SendInviteDialog',
    Modal: 'Modal', SafeAreaProvider: 'SafeAreaProvider', ScrollView: 'ScrollView', AppFrame: 'AppFrame', ScreenHeader: 'ScreenHeader', pageContentStyle: {}, ApiError, LoadingSpinner: 'LoadingSpinner', DialogFocus: 'DialogFocus', DialogScrollBody: 'DialogScrollBody', CancelDialogActions: 'CancelDialogActions', ErrorText: 'ErrorText', Dialog: Object.assign(() => {}, { Title: 'Dialog.Title' }),
    Keyboard: { dismiss() {} }, StyleSheet: { create: (value: any) => value, hairlineWidth: 1 }, Crypto: { randomUUID: () => `id-${++nextId}` }, useUI: () => ({ ui: {}, palette: {} }),
    requestAnimationFrame: (callback: () => void) => { callback(); return 1; }, cancelAnimationFrame() {},
    setTimeout: (callback: () => void) => { const id = ++nextId; timers.set(id, callback); return id; }, clearTimeout: (id: number) => timers.delete(id),
    useState: (initial: any) => { const id = cursor++; if (!(id in states)) states[id] = initial; return [states[id], (value: any) => { states[id] = typeof value === 'function' ? value(states[id]) : value; }]; },
    useRef: (initial: any) => { const id = cursor++; return states[id] ??= { current: initial }; },
    useEffect: (fn: () => any, values: any[]) => { const id = cursor++; if (!dependencies[id] || values.some((value, i) => value !== dependencies[id][i])) { effects.push(() => { cleanups[id]?.(); cleanups[id] = fn(); }); dependencies[id] = values; } },
    cachedRead: () => undefined,
    ...extra,
  };
  const source = ts.createSourceFile(file, readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const body = source.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(source).replace(/^export (?:default )?/, '')).join('\n');
  const names = source.statements.filter(ts.isFunctionDeclaration).map(node => node.name?.text).filter(Boolean);
  const code = ts.transpile(body, { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React });
  const functions = new Function('env', `with(env){ const StaggerItem = 'StaggerItem';${code}; return {${names.join(',')}};}`)(env);
  return {
    invoke(name: string, argument: any): any { return functions[name](argument); },
    render(name: string, props: any): Element { cursor = 0; return functions[name](props); },
    async commit() { const pending = effects; effects = []; pending.forEach(fn => fn()); await tick(); },
    timer() { const pending = [...timers.values()]; timers.clear(); pending.forEach(fn => fn()); },
    unmount() { Object.values(cleanups).forEach(fn => fn?.()); },
  };
}

function prepareJoin(app: ReturnType<typeof production>, props: any, title = 'Join as new', name = 'Friend') {
  button(app.render('GroupJoinDialog', props), title).props.onPress();
  component(app.render('GroupJoinDialog', props), 'TextField').props.onChangeText(name);
  button(app.render('GroupJoinDialog', props), 'Review join').props.onPress();
  return app.render('GroupJoinDialog', props);
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

test('cancel dismisses the keyboard, restores the browser trigger and reopens the same controlled draft', async () => {
  let focused = 0, dismissed = 0;
  const trigger = { focus: () => focused++ };
  const app = production('MembersScreen.tsx', { Platform: { OS: 'web' }, Keyboard: { dismiss: () => dismissed++ },
    document: { querySelector: () => trigger, addEventListener() {}, removeEventListener() {} } });
  const group: Group = { id: 'group', name: 'Trip', owner_id: 1, version: 1, participants: [{ id: 'self', name: 'You', user_id: 1 }], expenses: [], settlements: [], balances: {}, transfers: [], activity: [] };
  let addPersonRequest = 0;
  const render = () => app.render('MemberSettings', { group, selfId: 'self', busy: false, addPersonRequest, onMembership() {}, onAction: async () => { throw Error('Cancel must not save'); } });
  try {
    render(); await app.commit(); addPersonRequest++; render(); await app.commit();
    component(render(), 'AddPersonDialog').props.onName('Retained draft');
    component(render(), 'AddPersonDialog').props.onClose();
    assert.equal(component(render(), 'AddPersonDialog').props.visible, false);
    assert.equal(dismissed, 1); assert.equal(focused, 1);
    addPersonRequest++; render(); await app.commit();
    const reopened = component(render(), 'AddPersonDialog');
    assert.equal(reopened.props.visible, true); assert.equal(reopened.props.name, 'Retained draft');
  } finally { app.unmount(); }
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
    assert.equal(body.children.join(''), `Send an invite to ${props.email}?`);
    assert.equal(body.props.numberOfLines, undefined, 'long email must wrap');
    assert.equal(component(tree, 'ErrorText').children[0], props.error);
    button(tree, 'Send').props.onPress(); component(tree, 'CancelDialogActions').props.onCancel(); assert.equal(sends, 1); assert.equal(cancels, 1);
    const busy = app.render('SendInviteDialog', { ...props, busy: true }); await app.commit();
    assert.equal(button(busy, 'Sending').props.disabled, true); assert.equal(component(busy, 'CancelDialogActions').props.disabled, true);
    component(busy, 'KeyboardDialog').props.onDismiss(); assert.equal(cancels, 1);
    assert.equal(component(busy, 'KeyboardDialog').props.dismissable, false);
  } finally { app.unmount(); }
});

test('Member rows have one Invite action regardless of delivery state, with a separate Review action for a claim', () => {
  const app = production('MembersScreen.tsx'), group: Group = { id: 'group', name: 'Trip', owner_id: 1, version: 1, participants: [], expenses: [], settlements: [], balances: {}, transfers: [], activity: [] };
  const person = { id: 'person', name: 'Noor', email: 'noor@example.invalid', user_id: null };
  let opens = 0;
  for (const state of ['sent', 'failed', 'sending']) {
    group.invites = [{ id: 'invite', participant_id: person.id, intended_email: person.email, send_state: state, approved: false, revoked: false, claimant_id: null, claimant_email: null }];
    const tree = app.render('MemberRow', { group, person, selfId: 'self', organizer: true, disabled: false, onInvite: () => opens++ });
    button(tree, 'Invite').props.onPress(); assert.equal(button(tree, 'Send'), undefined);
  }
  assert.equal(opens, 3);
  group.invites = [{ id: 'claim', participant_id: person.id, approved: false, revoked: false, claimant_id: 2, claimant_email: 'noor@example.invalid' }];
  assert.equal(button(app.render('MemberRow', { group, person, selfId: 'self', organizer: true, disabled: true }), 'Review').props.disabled, true);
});


test('guest name edit waits for confirmation, preserves failed draft and retries one command', async () => {
  let resolve!: (value: any) => void, reject!: (error: Error) => void;
  const panel = settings(false, async () => new Promise((yes, no) => { resolve = yes; reject = no; }));
  let tree = await panel.add('');
  const member = nodes(tree).find(node => node.type?.name === 'MemberRow' && node.props.person.id !== 'self')!;
  member.props.onInvite(); tree = panel.render(); component(tree, 'PersonInviteDialog').props.onRename(); tree = panel.render();
  assert.equal(component(tree, 'EditNameDialog').props.name, 'Noor');
  component(tree, 'EditNameDialog').props.onName('Noor updated'); tree = panel.render();
  component(tree, 'EditNameDialog').props.onSave(); component(tree, 'EditNameDialog').props.onSave(); await tick();
  const writes = () => panel.calls.filter(call => call.path.endsWith('/name'));
  assert.equal(writes().length, 1); assert.equal(panel.group.participants[1].name, 'Noor');
  assert.equal(component(panel.render(), 'EditNameDialog').props.disabled, true);
  reject(Error('Offline')); await tick(); tree = panel.render();
  assert.equal(component(tree, 'EditNameDialog').props.name, 'Noor updated');
  assert.equal(component(tree, 'EditNameDialog').props.feedback.error, true);
  component(tree, 'EditNameDialog').props.onSave(); await tick();
  assert.equal(writes().length, 2); assert.equal(writes()[0].body.command_id, writes()[1].body.command_id);
  resolve({ id: panel.group.id, version: ++panel.group.version }); await tick();
  assert.equal(component(panel.render(), 'EditNameDialog').props.person, undefined);
  assert.equal(panel.calls.filter(call => call.path.endsWith('/email-invite')).length, 0);
  panel.unmount();
});

test('guest name save is blocked when the person joins or is removed while the dialog is open', async () => {
  for (const change of ['joined', 'removed', 'archived']) {
    const panel = settings(); let tree = await panel.add('');
    nodes(tree).find(node => node.type?.name === 'MemberRow' && node.props.person.id !== 'self')!.props.onInvite();
    component(panel.render(), 'PersonInviteDialog').props.onRename();
    tree = panel.render(); component(tree, 'EditNameDialog').props.onName('Changed');
    if (change === 'joined') panel.group.participants[1].user_id = 2;
    else if (change === 'removed') panel.group.participants[1].removed = true;
    else panel.group.archived = true;
    tree = panel.render(); const dialog = component(tree, 'EditNameDialog');
    assert.equal(dialog.props.unavailable, true); assert.equal(dialog.props.disabled, false, 'Cancel remains available'); dialog.props.onSave(); await tick();
    assert.equal(panel.calls.filter(call => call.path.endsWith('/name')).length, 0);
    panel.unmount();
  }
});


test('shared group creation starts solo and keeps optional person emails aligned', () => {
  const output:any[]=[];const app=production('CreateGroupForm.tsx',{Form:'Form'});
  const render=()=>app.render('CreateGroupForm',{direct:false,busy:false,onCreate:(v:any)=>output.push(v)});
  let tree=render();assert.equal(nodes(tree).filter(n=>n.type==='EmailField').length,0);
  nodes(tree).find(n=>n.props.label==='Group name')!.props.onChangeText('Trip');
  tree=render();button(tree,'Create group').props.onPress();assert.deepEqual(output[0].people,[]);
  button(tree,'Add person (optional)').props.onPress();tree=render();
  nodes(tree).find(n=>n.props.label==='Person 1')!.props.onChangeText('Noor');
  nodes(tree).find(n=>n.props.label==='Person 1 email (optional)')!.props.onChangeText('noor@example.invalid');
  tree=render();button(tree,'Create group').props.onPress();assert.deepEqual(output[1].emails,['noor@example.invalid']);
  button(tree,'Remove person 1').props.onPress();tree=render();button(tree,'Create group').props.onPress();assert.deepEqual(output[2].people,[]);app.unmount();
});

test('group invite preview never joins automatically; explicit duplicate presses join once', async () => {
  const calls:any[]=[],joined:string[]=[];let finish!: (value:any)=>void;
  const app=production('GroupJoinDialog.tsx',{request:async(_s:any,path:string,_m:string,body:any)=>{calls.push({path,body});if(path.endsWith('preview'))return{name:'Trip',already_member:false,version:2,people:[]};return new Promise(r=>{finish=r;});}});
  const props={session:{token:'account-A',email:'a@example.invalid'},token:'synthetic-capability',onJoined:async(id:string)=>{joined.push(id);},onCancel(){}};
  const render=()=>app.render('GroupJoinDialog',props);render();await app.commit();let tree=render();
  assert.equal(calls.length,1);assert.equal(button(tree,'Join as new').props.disabled,false);
  prepareJoin(app, props); tree=render();button(tree,'Join as Friend').props.onPress();button(tree,'Join as Friend').props.onPress();await tick();assert.equal(calls.length,2);
  finish({id:'group'});await tick();assert.deepEqual(joined,['group']);app.unmount();
});

test('group join completion after account-scope unmount cannot open another account group', async () => {
  let finish!:(v:any)=>void;let joined=0;
  const app=production('GroupJoinDialog.tsx',{request:async(_s:any,p:string)=>p.endsWith('preview')?{name:'Trip',already_member:false,version:2,people:[]}:new Promise(r=>{finish=r;})});
  const props={session:{token:'account-A',email:'a@example.invalid'},token:'synthetic',onJoined:async()=>{joined++;},onCancel(){}};
  app.render('GroupJoinDialog',props);await app.commit();prepareJoin(app, props);button(app.render('GroupJoinDialog',props),'Join as Friend').props.onPress();await tick();app.unmount();finish({id:'group'});await tick();assert.equal(joined,0);
});

test('uncertain group link receipt is not shareable and retries the same command', async () => {
 let accepted=false;
 const panel=settings(false,async(path,body)=>path==='/invite-link'&&accepted?{id:'group',version:2,url:'https://merosplit.com/j/'+'a'.repeat(32)}:{});
 let tree=panel.render();button(tree,'Copy group link').props.onPress();await tick();tree=panel.render();
 assert.equal(nodes(tree).some(n=>n.props.title==='Share link'),false);
 accepted=true;button(tree,'Copy group link').props.onPress();await tick();
 assert.equal(nodes(panel.render()).some(n=>n.props.title==='Share link'),false);
 assert.equal(component(panel.render(),'FeedbackNote').props.feedback.text,'Link copied');
 const calls=panel.calls.filter(c=>c.path==='/invite-link');assert.equal(calls.length,2);assert.equal(calls[0].body.command_id,calls[1].body.command_id);
 panel.unmount();
});


test('group link and join command IDs are lazy and retained through uncertain retries', async () => {
  let ids = 0;
  const crypto = { randomUUID: () => `lazy-${++ids}` };
  const members = production('MembersScreen.tsx', { Crypto: crypto });
  const group: Group = { id: 'group', name: 'Trip', owner_id: 1, version: 1, participants: [{ id: 'self', name: 'You', user_id: 1 }], expenses: [], settlements: [], balances: {}, transfers: [], activity: [] };
  const writes: any[] = [];
  const props = { group, selfId: 'self', busy: false, onMembership() {}, onAction: async (_path: string, body: any) => { writes.push(body); throw Error('Unknown response'); } };
  for (let i = 0; i < 3; i++) members.render('MemberSettings', props);
  assert.equal(ids, 0, 'ordinary renders do not consume command IDs');
  button(members.render('MemberSettings', props), 'Copy group link').props.onPress(); await tick();
  button(members.render('MemberSettings', props), 'Copy group link').props.onPress(); await tick();
  assert.equal(ids, 1); assert.deepEqual(writes.map(v => v.command_id), ['lazy-1', 'lazy-1']); members.unmount();
  const joins: any[] = [];
  const dialog = production('GroupJoinDialog.tsx', { Crypto: crypto, request: async (_session: any, path: string, _method: string, body: any) => { if (path.endsWith('preview')) return { name: 'Trip', already_member: false, version: 2, people: [] }; joins.push(body); throw Error('Unknown response'); } });
  const joinProps = { session: { token: 'account-a', email: 'a@example.invalid' }, token: 'synthetic', onJoined: async () => {}, onCancel() {} };
  dialog.render('GroupJoinDialog', joinProps); await dialog.commit(); dialog.render('GroupJoinDialog', joinProps); assert.equal(ids, 1);
  prepareJoin(dialog, joinProps);
  for (let i = 0; i < 2; i++) { button(dialog.render('GroupJoinDialog', joinProps), i === 0 ? 'Join as Friend' : 'Try again').props.onPress(); await tick(); }
  assert.equal(ids, 2); assert.deepEqual(joins.map(v => v.command_id), ['lazy-2', 'lazy-2']); dialog.unmount();
});


test('Copy link uses the platform helper, exposes no URL and reports clipboard failure truthfully', async () => {
 for(const platform of ['native','web']) {
  let fail=true; const copied:string[]=[], commands:string[]=[];
  const url='https://merosplit.com/j/'+'b'.repeat(32);
  const app=production('MembersScreen.tsx',{Platform:{OS:platform},copyText:async(value:string|Promise<string>)=>{copied.push(await value);if(fail)throw Error(url);}});
  const group:Group={id:'group',name:'Trip',owner_id:1,version:2,participants:[{id:'self',name:'You',user_id:1}],expenses:[],settlements:[],balances:{},transfers:[],activity:[]};
  const props={group,selfId:'self',busy:false,onMembership(){},onAction:async(_path:string,body:any)=>{commands.push(body.command_id);return{id:'group',version:2,url};}};
  button(app.render('MemberSettings',props),'Copy group link').props.onPress();await tick();
  let tree=app.render('MemberSettings',props);
  assert.equal(component(tree,'FeedbackNote').props.feedback.text,'Could not copy link. Try again.');
  assert.ok(!JSON.stringify(tree).includes(url));
  fail=false;button(tree,'Copy group link').props.onPress();await tick();tree=app.render('MemberSettings',props);
  assert.deepEqual(copied,[url,url]);assert.equal(commands[0],commands[1]);
  assert.equal(component(tree,'FeedbackNote').props.feedback.text,'Link copied');
  assert.ok(!JSON.stringify(tree).includes(url));assert.equal(nodes(tree).some(n=>n.props.title==='Share link'),false);
  app.unmount();
 }
});


function updateModule() {
 const calls:string[]=[], state:any={currentlyRunning:{isEmergencyLaunch:false,isEmbeddedLaunch:true},isUpdatePending:false,isUpdateAvailable:false};
 const module:any={isEnabled:true,runtimeVersion:'native-fingerprint',channel:'merosplit-production',UpdateInfoType:{ROLLBACK:'rollback'},useUpdates:()=>state,
  checkForUpdateAsync:async()=>{calls.push('check');return{isAvailable:true,isRollBackToEmbedded:false};},
  fetchUpdateAsync:async()=>{calls.push('download');return{isNew:true,isRollBackToEmbedded:false};},reloadAsync:async()=>{calls.push('reload');}};
 return {module,state,calls};
}

test('manual update screen adds no JS startup polling; Check, Download and Restart stay explicit', async () => {
 const native=updateModule(), lock={current:false};
 const app=production('AppUpdates.tsx',{Updates:native.module});
 const props={busy:false,online:true,onRestart:(reload:()=>Promise<void>)=>restartForUpdate({lock,safe:()=>true,flushWrites:async()=>{native.calls.push('flush');},reload})};
 let tree=app.render('AppUpdates',props);await app.commit();assert.deepEqual(native.calls,[]);
 button(tree,'Check').props.onPress();button(tree,'Check').props.onPress();await tick();
 assert.deepEqual(native.calls,['check']);tree=app.render('AppUpdates',props);assert.ok(button(tree,'Download'));
 button(tree,'Download').props.onPress();await tick();assert.deepEqual(native.calls,['check','download']);
 tree=app.render('AppUpdates',props);assert.ok(JSON.stringify(tree).includes('may also apply the next time'));
 button(tree,'Restart').props.onPress();await tick();assert.deepEqual(native.calls,['check','download','flush','reload']);
 assert.equal(lock.current,true,'successful reload retains lock until native replaces JS');
 app.unmount();
});

test('native automatic downloads update manual controls without polling JS or forcing an in-session reload', async () => {
 for (const platform of ['ios', 'android']) {
  const native=updateModule(), app=production('AppUpdates.tsx',{Updates:native.module,Platform:{OS:platform}});
  let restarts=0;
  const props={busy:false,online:true,onRestart:async()=>{restarts++;}};
  native.state.isStartupProcedureRunning=true;
  let tree=app.render('AppUpdates',props);await app.commit();
  assert.equal(button(tree,'Check').props.disabled,true);
  native.state.isStartupProcedureRunning=false;native.state.isDownloading=true;
  tree=app.render('AppUpdates',props);await app.commit();assert.ok(JSON.stringify(tree).includes('Downloading…'));
  native.state.isDownloading=false;native.state.isUpdatePending=true;
  tree=app.render('AppUpdates',props);await app.commit();
  assert.ok(button(tree,'Restart'));assert.equal(restarts,0);assert.deepEqual(native.calls,[]);
  tree=app.render('AppUpdates',{...props,busy:true});button(tree,'Restart').props.onPress();await tick();assert.equal(restarts,0);
  button(app.render('AppUpdates',props),'Restart').props.onPress();await tick();assert.equal(restarts,1);
  app.unmount();
 }
});

test('manual update controls reject the old testing channel, missing runtime and disabled native updates', () => {
 for (const overrides of [{channel:'merosplit-1-1-testing'},{channel:null},{runtimeVersion:null},{isEnabled:false}]) {
  const native=updateModule();Object.assign(native.module,overrides);
  const app=production('AppUpdates.tsx',{Updates:native.module});
  const tree=app.render('AppUpdates',{busy:false,online:true,onRestart:async()=>{assert.fail();}});
  assert.equal(button(tree,'Check'),undefined);assert.deepEqual(native.calls,[]);app.unmount();
 }
});

test('update footer reports the installed binary and running update, never a pending download or mutable manifest version', () => {
 const native=updateModule();native.state.currentlyRunning.updateId='embedded-id';native.state.isUpdatePending=true;
 const app=production('AppUpdates.tsx',{Updates:native.module,Constants:{expoConfig:{version:'99.9',ios:{buildNumber:'999'}}}});
 const props={busy:false,online:true,onRestart:async()=>{assert.fail();}};
 let tree=app.render('AppUpdates',props);
 assert.ok(JSON.stringify(tree).includes('Version 1.2 (27)'));assert.ok(JSON.stringify(tree).includes('Built-in version'));
 assert.ok(!JSON.stringify(tree).includes('Update installed'));assert.ok(!JSON.stringify(tree).includes('99.9'));
 assert.equal(nodes(tree).some(node=>node.type==='SettingsRow'),false);
 native.state.currentlyRunning.isEmbeddedLaunch=false;native.state.currentlyRunning.updateId='actual-downloaded-update';
 tree=app.render('AppUpdates',props);assert.ok(JSON.stringify(tree).includes('Update installed'));
 assert.ok(!JSON.stringify(tree).includes('actual-downloaded-update'),'technical update IDs stay out of the footer');
 app.unmount();
 const fallback=production('AppUpdates.tsx',{Updates:native.module,Platform:{OS:'ios'},requireOptionalNativeModule:()=>null,Constants:{platform:{ios:{buildNumber:'42'}},expoConfig:{version:'99.9',ios:{buildNumber:'999'}}}});
 tree=fallback.render('AppUpdates',props);assert.ok(JSON.stringify(tree).includes('Build 42'));assert.ok(!JSON.stringify(tree).includes('99.9'));fallback.unmount();
 const web=production('AppUpdates.tsx',{Updates:native.module,Platform:{OS:'web'}});
 tree=web.render('AppUpdates',props);assert.equal(button(tree,'Check for update'),undefined);assert.ok(JSON.stringify(tree).includes('reload the page'));assert.ok(!JSON.stringify(tree).includes('Version 1.2'));web.unmount();
});

test('footer Check starts one existing check and opens progress, while a downloaded update still needs explicit Restart', async () => {
 const native=updateModule(),app=production('AppUpdates.tsx',{Updates:native.module});let restarts=0;
 const props={busy:false,online:true,onRestart:async()=>{restarts++;}};
 let tree=app.render('AppUpdates',props);button(tree,'Check for update').props.onPress();button(tree,'Check for update').props.onPress();await tick();
 tree=app.render('AppUpdates',props);assert.equal(component(tree,'KeyboardDialog').props.visible,true);assert.deepEqual(native.calls,['check']);
 native.state.isUpdatePending=true;button(app.render('AppUpdates',props),'Check for update').props.onPress();await tick();assert.equal(restarts,0);
 button(app.render('AppUpdates',props),'Restart').props.onPress();await tick();assert.equal(restarts,1);app.unmount();
});

test('Account mounts exactly one update footer after all settings and account actions', () => {
 const source=ts.createSourceFile('App.tsx',readFileSync(new URL('../App.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 const entries:ts.JsxSelfClosingElement[]=[];
 function visit(node:ts.Node){if(ts.isJsxSelfClosingElement(node)&&node.tagName.getText(source)==='AppUpdates')entries.push(node);ts.forEachChild(node,visit);}
 visit(source);assert.equal(entries.length,1);
 const footer=entries[0],parent=footer.parent;assert.ok(ts.isJsxFragment(parent));
 assert.equal(parent.children.filter(node=>!ts.isJsxText(node)).at(-1),footer);
 const content=parent.getText(source);assert.ok(content.indexOf('<DeleteAccount')<content.indexOf('<AppUpdates'));
});

test('update checks and downloads report failures, preserve retry, and block offline or unsupported builds', async () => {
 for(const extra of [{Platform:{OS:'web'}},{__DEV__:true}]) {
  const native=updateModule(), app=production('AppUpdates.tsx',{Updates:native.module,...extra});
  const tree=app.render('AppUpdates',{busy:false,online:true,onRestart:async()=>{assert.fail();}});
  assert.equal(button(tree,'Check'),undefined);assert.deepEqual(native.calls,[]);app.unmount();
 }
 const native=updateModule(), app=production('AppUpdates.tsx',{Updates:native.module});
 let online=false;
 const props=()=>({busy:false,online,onRestart:async()=>{throw Error('Finish the payment first.');}});
 button(app.render('AppUpdates',props()),'Check').props.onPress();await tick();assert.deepEqual(native.calls,[]);
 assert.ok(JSON.stringify(app.render('AppUpdates',props())).includes('Connect to the internet'));
 online=true;native.module.checkForUpdateAsync=async()=>{throw Error('provider details should stay private');};
 button(app.render('AppUpdates',props()),'Check').props.onPress();await tick();
 assert.ok(JSON.stringify(app.render('AppUpdates',props())).includes("Couldn't check"));
 native.module.checkForUpdateAsync=async()=>({isAvailable:true,isRollBackToEmbedded:false});
 button(app.render('AppUpdates',props()),'Check').props.onPress();await tick();
 native.module.fetchUpdateAsync=async()=>{throw Error('download-provider');};
 button(app.render('AppUpdates',props()),'Download').props.onPress();await tick();
 assert.ok(button(app.render('AppUpdates',props()),'Download'));assert.ok(JSON.stringify(app.render('AppUpdates',props())).includes('Download failed'));
 native.state.isUpdatePending=true;
 button(app.render('AppUpdates',props()),'Restart').props.onPress();await tick();
 assert.ok(JSON.stringify(app.render('AppUpdates',props())).includes('Finish the payment first.'));assert.ok(button(app.render('AppUpdates',props()),'Restart'));
 app.unmount();
});

test('downloaded native state survives component remount, including embedded rollback and emergency launch', async () => {
 const native=updateModule();native.state.isUpdatePending=true;native.state.downloadedUpdate={type:'rollback'};
 const app=production('AppUpdates.tsx',{Updates:native.module});
 let tree=app.render('AppUpdates',{busy:false,online:false,onRestart:async()=>{}});
 assert.ok(button(tree,'Restart'));assert.ok(JSON.stringify(tree).includes('built-in version is ready'));
 assert.deepEqual(native.calls,[]);app.unmount();
 native.state.isUpdatePending=false;native.state.downloadedUpdate=undefined;native.state.currentlyRunning.isEmergencyLaunch=true;
 const remount=production('AppUpdates.tsx',{Updates:native.module});
 tree=remount.render('AppUpdates',{busy:false,online:true,onRestart:async()=>{}});
 assert.ok(JSON.stringify(tree).includes('after an update problem'));assert.ok(!JSON.stringify(tree).includes('latest version'));remount.unmount();
});

test('update restart waits for writes and rechecks live account, route, auth, foreground and payment safety', async () => {
 for(const reason of ['account changed','route changed','auth started','background','payment started']) {
  const lock={current:false};let safe=true, resolve!:()=>void, reloads=0;
  const writes=new Promise<void>(r=>{resolve=r;});
  const operation=restartForUpdate({lock,safe:()=>safe,flushWrites:()=>writes,reload:async()=>{reloads++;}});
  assert.equal(lock.current,true);safe=false;resolve();
  await assert.rejects(operation,/Finish what's in progress/,reason);assert.equal(reloads,0);assert.equal(lock.current,false);
 }
 const lock={current:false};let reloads=0;
 await assert.rejects(restartForUpdate({lock,safe:()=>true,flushWrites:async()=>{throw Error('draft write failed');},reload:async()=>{reloads++;}}),/draft write failed/);
 assert.equal(lock.current,false);assert.equal(reloads,0);
 await assert.rejects(restartForUpdate({lock,safe:()=>true,flushWrites:async()=>{},reload:async()=>{throw Error('native reload failed');}}),/native reload failed/);assert.equal(lock.current,false);
 lock.current=true;await assert.rejects(restartForUpdate({lock,safe:()=>true,flushWrites:async()=>{assert.fail();},reload:async()=>{assert.fail();}}),/Finish what's in progress/);
});

test('the actual App restart guard blocks editing and waits for pending draft and chat writes', async () => {
 const source=ts.createSourceFile('App.tsx',readFileSync(new URL('../App.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 let guard='', restart='';
 function visit(node:ts.Node) {
  if(ts.isExpressionStatement(node)&&node.getText(source).startsWith('updateSafe.current =')) guard=node.getText(source);
  if(ts.isFunctionDeclaration(node)&&node.name?.text==='restartUpdate') restart=node.getText(source);
  ts.forEachChild(node,visit);
 }
 visit(source);assert.ok(guard&&restart);
 const code=ts.transpile(`${guard}\n${restart}`,{target:ts.ScriptTarget.ES2022});
 const make=(extra:Record<string,any>={})=>{
  const session={token:'current-account'},calls:string[]=[];
  const env:any={ready:true,session,expired:false,authHeld:false,foreground:true,screen:'home',tab:'Account',busy:false,reading:0,pulling:false,storageError:null,appLink:null,emailEntry:null,feedbackOpen:false,alertOpen:false,upiSetup:false,pushInvitationOpen:false,returnAttemptId:null,returns:[],reviewCommand:null,newPersonInvite:null,pushTarget:null,
   updateSafe:{current:false},activeSessionRef:{current:session},authEpoch:{current:1},lock:{current:false},AppState:{currentState:'active'},authHeldRef:{current:false},draftWrites:{current:Promise.resolve()},flushChatWrites:async()=>{calls.push('chat-flush');},accountOwner:()=> 'current-owner',restartForUpdate,...extra};
  return {env,calls,restart:new Function('env',`with(env){ const StaggerItem = 'StaggerItem';${code};return restartUpdate;}`)(env)};
 };
 for(const state of [{screen:'expense'},{screen:'settle'},{busy:true},{reading:1},{pushInvitationOpen:true},{authHeld:true},{returnAttemptId:'payment'},{reviewCommand:{}}]) {
  const app=make(state);
  await assert.rejects(app.restart(async()=>{assert.fail('unsafe reload');}),/Finish what's in progress/);
  assert.deepEqual(app.calls,[]);assert.equal(app.env.lock.current,false);
 }
 let release!:()=>void,chatRelease!:()=>void,reloaded=false;
 const drafts=new Promise<void>(resolve=>{release=resolve;}),chat=new Promise<void>(resolve=>{chatRelease=resolve;});
 const app=make({draftWrites:{current:drafts},flushChatWrites:()=>chat});
 const operation=app.restart(async()=>{reloaded=true;});await tick();assert.equal(reloaded,false);
 release();await tick();assert.equal(reloaded,false);chatRelease();await operation;assert.equal(reloaded,true);
});


test('an empty download clears the stale available action and permits an explicit recheck', async () => {
 const native=updateModule();native.state.isUpdateAvailable=true;native.module.fetchUpdateAsync=async()=>({isNew:false,isRollBackToEmbedded:false});
 const app=production('AppUpdates.tsx',{Updates:native.module});
 const props={busy:false,online:true,onRestart:async()=>{assert.fail();}};
 button(app.render('AppUpdates',props),'Download').props.onPress();await tick();
 const tree=app.render('AppUpdates',props);assert.ok(button(tree,'Check'));assert.equal(button(tree,'Restart'),undefined);
 assert.ok(JSON.stringify(tree).includes('No update was downloaded.'));app.unmount();
});


test('group link starts the real browser clipboard write inside the click, before deferred API completion', async () => {
  let gesture = false, resolve!: (value: any) => void;
  const events: string[] = [], copied: string[] = [];
  const response = new Promise<any>(value => { resolve = value; });
  const url = 'https://merosplit.com/j/' + 'c'.repeat(32);
  class Item { data: Record<string, Promise<Blob>>; constructor(data: Record<string, Promise<Blob>>) { this.data = data; } }
  const web = production('clipboard.web.ts', { Blob, ClipboardItem: Item, navigator: { clipboard: {
    writeText: async (value: string) => { events.push('writeText'); if (!gesture) throw Error('NotAllowedError'); copied.push(value); },
    write: (items: Item[]) => { events.push('write'); if (!gesture) return Promise.reject(Error('NotAllowedError')); return Promise.all(items.map(async item => { copied.push(await (await item.data['text/plain']).text()); })).then(() => {}); },
  } } });
  const app = production('MembersScreen.tsx', { copyText: (value: string | Promise<string>) => web.invoke('copyText', value) });
  const group: Group = { id: 'group', name: 'Trip', owner_id: 1, version: 2, participants: [{ id: 'self', name: 'You', user_id: 1 }], expenses: [], settlements: [], balances: {}, transfers: [], activity: [] };
  const props = { group, selfId: 'self', busy: false, onMembership() {}, onAction: () => { events.push('api'); return response; } };
  gesture = true;
  button(app.render('MemberSettings', props), 'Copy group link').props.onPress();
  gesture = false;
  const initiatedBeforeResponse = events.includes('write');
  resolve({ id: 'group', version: 2, url }); await tick();
  try {
    assert.equal(initiatedBeforeResponse, true, 'clipboard.write must start before the API resolves and the click gesture expires');
    assert.deepEqual(events, ['api', 'write']); assert.deepEqual(copied, [url]);
    assert.equal(component(app.render('MemberSettings', props), 'FeedbackNote').props.feedback.text, 'Link copied');
  } finally { app.unmount(); }
});


test('clipboard helpers preserve synchronous UPI copies and native behavior, and observe rejected deferred data', async () => {
  const calls: string[] = [];
  const native = production('clipboard.ts', { Clipboard: { setString: (value: string) => calls.push(value) } });
  const first = native.invoke('copyText', 'person@upi');
  assert.deepEqual(calls, ['person@upi']); await first;
  let resolve!: (value: string) => void;
  const pending = native.invoke('copyText', new Promise<string>(value => { resolve = value; }));
  assert.deepEqual(calls, ['person@upi']); resolve('later@upi'); await pending;
  assert.deepEqual(calls, ['person@upi', 'later@upi']);
  await assert.rejects(native.invoke('copyText', Promise.reject(Error('API failed'))), /API failed/);
  assert.deepEqual(calls, ['person@upi', 'later@upi']);
  let writes = 0;
  class Item { constructor(_data: any) {} }
  const web = production('clipboard.web.ts', { Blob, ClipboardItem: Item, navigator: { clipboard: {
    writeText: (value: string) => { calls.push(value); return Promise.resolve(); },
    write: () => { writes++; return Promise.reject(Error('denied')); },
  } } });
  const upi = web.invoke('copyText', 'browser@upi');
  assert.equal(calls.at(-1), 'browser@upi'); assert.equal(writes, 0); await upi;
  let reject!: (error: Error) => void;
  const data = new Promise<string>((_resolve, fail) => { reject = fail; });
  await assert.rejects(web.invoke('copyText', data), /denied/);
  reject(Error('late API failure')); await tick();
  assert.equal(writes, 1, 'denial must not trigger a second clipboard attempt');
});

test('deferred clipboard data never resolves for a rejected receipt or changed owner/group', async () => {
  for (const condition of ['api', 'receipt', 'owner', 'group', 'archived', 'unmount']) {
    let resolve!: (value: any) => void, reject!: (error: Error) => void;
    const response = new Promise<any>((ok, fail) => { resolve = ok; reject = fail; });
    const copied: string[] = []; let writes = 0;
    class Item { data: Record<string, Promise<Blob>>; constructor(data: Record<string, Promise<Blob>>) { this.data = data; } }
    const web = production('clipboard.web.ts', { Blob, ClipboardItem: Item, navigator: { clipboard: {
      write: (items: Item[]) => { writes++; return Promise.all(items.map(async item => copied.push(await (await item.data['text/plain']).text()))).then(() => {}); },
    } } });
    const app = production('MembersScreen.tsx', { copyText: (value: string | Promise<string>) => web.invoke('copyText', value) });
    const group: Group = { id: 'group', name: 'Trip', owner_id: 1, version: 2, participants: [{ id: 'self', name: 'You', user_id: 1 }], expenses: [], settlements: [], balances: {}, transfers: [], activity: [] };
    const props = { group, selfId: 'self', busy: false, onMembership() {}, onAction: () => response };
    button(app.render('MemberSettings', props), 'Copy group link').props.onPress();
    assert.equal(writes, 1, 'clipboard initialization precedes response validation');
    if (condition === 'owner') app.render('MemberSettings', { ...props, group: { ...group, owner_id: 2 } });
    if (condition === 'group') app.render('MemberSettings', { ...props, group: { ...group, id: 'other' } });
    if (condition === 'archived') app.render('MemberSettings', { ...props, group: { ...group, archived: true } });
    if (condition === 'unmount') { await app.commit(); app.unmount(); }
    if (condition === 'api') reject(Error('API unavailable'));
    else resolve({ id: 'group', version: 2, url: condition === 'receipt' ? 'https://untrusted.invalid/j/secret' : 'https://merosplit.com/j/' + 'd'.repeat(32) });
    await tick(); assert.deepEqual(copied, [], condition);
    if (condition === 'api') assert.equal(component(app.render('MemberSettings', props), 'FeedbackNote').props.feedback.text, 'API unavailable');
    app.unmount();
  }
});


test('existing-person choice and name edit wait for explicit final confirmation, then submit the stable ID', async () => {
  const calls:any[]=[];let done=0;
  const app=production('GroupJoinDialog.tsx',{request:async(_s:any,path:string,_m:string,body:any)=>{
    calls.push({path,body});return path.endsWith('preview')?{name:'Trip',already_member:false,version:9,people:[{id:'old-person',name:'John'}]}:{id:'group'};
  }});
  const props={session:{token:'A',email:'a@example.invalid'},token:'capability',onJoined:async()=>{done++;},onCancel(){}};
  app.render('GroupJoinDialog',props);await app.commit();
  const tree=prepareJoin(app,props,'This is me','John Doe');
  assert.equal(calls.length,1,'selection and edit do not join');
  assert.ok(nodes(tree).some(n=>n.children.includes("John's existing bills and payments will be linked to you in this group.")));
  button(tree,'Join as John Doe').props.onPress();await tick();
  assert.equal(calls.length,2);assert.deepEqual(calls[1].body,{token:'capability',command_id:'id-1',display_name:'John Doe',participant_id:'old-person',preview_version:9});
  assert.equal(done,1);app.unmount();
});

test('a stale selected person requires refreshed choices and never silently joins as new', async () => {
  const writes:any[]=[];let previews=0;
  const app=production('GroupJoinDialog.tsx',{request:async(_s:any,path:string,_m:string,body:any)=>{
    if(path.endsWith('preview'))return{name:'Trip',already_member:false,version:++previews,people:previews===1?[{id:'old-person',name:'John'}]:[]};
    writes.push(body);throw new ApiError(409,'This person changed. Refresh and choose again.');
  }});
  const props={session:{token:'A',email:'a@example.invalid'},token:'capability',onJoined:async()=>assert.fail('not joined'),onCancel(){}};
  app.render('GroupJoinDialog',props);await app.commit();button(prepareJoin(app,props,'This is me','John'),'Join as John').props.onPress();await tick();
  let tree=app.render('GroupJoinDialog',props);assert.equal(writes.length,1);assert.equal(writes[0].participant_id,'old-person');
  button(tree,'Refresh invitation').props.onPress();tree=app.render('GroupJoinDialog',props);await app.commit();tree=app.render('GroupJoinDialog',props);
  assert.equal(button(tree,'This is me'),undefined);assert.ok(button(tree,'Join as new'));assert.equal(writes.length,1);app.unmount();
});

test('full-screen join keeps its header inside a modal-local safe area through confirmation, 409 and Refresh', async () => {
  let previews = 0;
  const app = production('GroupJoinDialog.tsx', { request: async (_session: any, path: string) => {
    if (path.endsWith('preview')) return { name: 'Trip', already_member: false, version: ++previews, people: previews === 1 ? [{ id: 'old-person', name: 'John' }] : [] };
    throw new ApiError(409, 'This person changed. Refresh and choose again.');
  } });
  const props = { session: { token: 'A', email: 'a@example.invalid' }, token: 'capability', onJoined: async () => assert.fail('not joined'), onCancel() {} };
  const states: [string, Element][] = [['loading', app.render('GroupJoinDialog', props)]];
  await app.commit();
  states.push(['loaded', app.render('GroupJoinDialog', props)]);
  button(states.at(-1)![1], 'This is me').props.onPress();
  states.push(['name', app.render('GroupJoinDialog', props)]);
  button(states.at(-1)![1], 'Review join').props.onPress();
  states.push(['confirmation', app.render('GroupJoinDialog', props)]);
  button(states.at(-1)![1], 'Join as John').props.onPress(); await tick();
  states.push(['rejected409', app.render('GroupJoinDialog', props)]);
  button(states.at(-1)![1], 'Refresh invitation').props.onPress();
  app.render('GroupJoinDialog', props); await app.commit();
  states.push(['refreshed', app.render('GroupJoinDialog', props)]);
  const navigation = production('AppNavigation.tsx', { SafeAreaView: 'SafeAreaView', StatusBar: 'StatusBar', KeyboardAvoidingView: 'KeyboardAvoidingView', radii: {} });
  for (const [state, tree] of states) {
    assert.equal(tree.type, 'Modal'); assert.equal(tree.props.presentationStyle, 'fullScreen');
    // A full-screen native Modal is a separate root. Its AppFrame must measure
    // that root's insets rather than using the presenting screen's provider.
    const provider = tree.children[0];
    assert.equal(provider.type, 'SafeAreaProvider', `${state}: modal-local inset measurement`);
    const frame = provider.children[0]; assert.equal(frame.type, 'AppFrame');
    const safeFrame = navigation.render('AppFrame', { children: frame.children });
    assert.equal(safeFrame.type, 'View');const safeContent=component(safeFrame,'SafeAreaView');assert.ok(safeContent);assert.deepEqual(safeContent.props.edges,['top','left','right','bottom']);
    assert.ok(component(frame, 'ScreenHeader'), `${state}: header stays inside the inset frame`);
    assert.ok(component(frame, 'DialogFocus')); assert.ok(component(frame, 'ScrollView'));
  }
  assert.equal(previews, 2); assert.ok(button(states.at(-1)![1], 'Join as new'));
  app.unmount();
});

test('member rows show a wrapped account email to ordinary members separately from invite contact', () => {
  const app=production('MembersScreen.tsx');const group:Group={id:'g',name:'Trip',owner_id:1,version:1,participants:[],expenses:[],settlements:[],balances:{},transfers:[],activity:[]};
  const email='a.very.long.authoritative.account.address@example.invalid';
  const props={group,person:{id:'p',name:'John Doe',user_id:2,account_email:email,email:'old-contact@example.invalid'},selfId:'viewer',organizer:false,disabled:false,working:false,feedback:null,cooldown:0,contactChanged:false,onAddEmail(){},onRename(){},onSend(){},onRemove(){}};
  const tree=app.render('MemberRow',props),text=nodes(tree).find(n=>n.children.includes(email));assert.ok(text);assert.equal(text.props.numberOfLines,undefined);assert.equal(text.props.accessibilityLabel,email);
  assert.equal(nodes(tree).some(n=>n.children.includes(props.person.email)),false);
  const removed=app.render('MemberRow',{...props,person:{...props.person,removed:true}});assert.equal(nodes(removed).some(n=>n.children.includes(email)),false);app.unmount();
});

test('actual App join callback adopts only the active account and ignores late account-switch results', async () => {
  const source=ts.createSourceFile('App.tsx',readFileSync(new URL('../App.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  let callback:ts.ArrowFunction|undefined;
  function visit(node:ts.Node){if(ts.isJsxSelfClosingElement(node)&&node.tagName.getText(source)==='GroupJoinDialog'){
    const attr=node.attributes.properties.find(p=>ts.isJsxAttribute(p)&&p.name.getText(source)==='onJoined') as ts.JsxAttribute;
    callback=(attr.initializer as ts.JsxExpression).expression as ts.ArrowFunction;
  }ts.forEachChild(node,visit);}visit(source);assert.ok(callback);
  for(const changeAt of ['none','before','fetch','save','load']){
    const session={token:'A',userId:'a'},active={current:{token:changeAt==='before'?'B':'A'}},calls:string[]=[];
    const env={session,activeSessionRef:active,accountOwner:(v:any)=>v.userId,
      fetchGroup:async()=>{calls.push('fetch');if(changeAt==='fetch')active.current.token='B';return{id:'g'};},
      getDatabase:async()=>({}),saveGroup:async(_db:any,owner:any)=>{assert.equal(owner,'a');calls.push('save');if(changeAt==='save')active.current.token='B';},
      forgetGroupInvite:()=>calls.push('forget'),saveGroupInvite:async()=>{},setAppLink(){},navigate(){calls.push('open');},load:async()=>{calls.push('load');if(changeAt==='load')active.current.token='B';},setPushOpportunity:(value:any)=>{assert.equal(value.token,'A');assert.equal(value.groupId,'g');calls.push('push-opportunity');}};
    const code=ts.transpile('const done='+callback!.getText(source),{target:ts.ScriptTarget.ES2022});
    const run=new Function('env',`with(env){${code};return done;}`)(env);await run('g');
    assert.deepEqual(calls,changeAt==='none'?['fetch','save','forget','open','load','push-opportunity']:changeAt==='load'?['fetch','save','forget','open','load']:changeAt==='before'?[]:changeAt==='fetch'?['fetch']:['fetch','save']);
  }
});

test('Previous members appear only in the counted dialog, leaving historical records untouched', () => {
  const app = production('MembersScreen.tsx');
  const group: Group = { id: 'history-group', name: 'Trip', owner_id: 1, version: 4,
    participants: [{ id: 'self', name: 'You', user_id: 1 }, { id: 'active', name: 'Sam', user_id: 2 },
      { id: 'old', name: 'John Doe', user_id: 3, removed: true, account_email: 'john@example.invalid' }],
    expenses: [], settlements: [], balances: { old: '1200' }, transfers: [], activity: [] };
  const before = JSON.stringify(group);
  const props = { group, selfId: 'self', busy: false, onMembership() {}, onAction: async () => { throw new Error('Read-only dialog must not write'); } };
  const render = () => app.render('MemberSettings', props);
  const active = (tree: any) => nodes(tree).filter(node => node.type?.name === 'MemberRow').map(node => node.props.person.id);
  let tree = render();
  assert.deepEqual(active(tree), ['self', 'active']);
  assert.equal(nodes(tree).some(node => node.type?.name === 'PreviousMembersDialog'), false);
  const row = nodes(tree).find(node => node.type === 'SettingsRow' && node.props.label === 'Previous members')!;
  assert.equal(row.props.value, '1'); row.props.onPress();
  tree = render();
  const dialog = component(tree, 'PreviousMembersDialog');
  assert.deepEqual(dialog.props.people.map((person: any) => person.id), ['old']);
  assert.deepEqual(active(tree), ['self', 'active']);
  const contents = app.invoke('PreviousMembersDialog', dialog.props);
  assert.deepEqual(nodes(contents).filter(node => node.type === 'Avatar').map(node => node.props.name), ['John Doe']);
  assert.deepEqual(nodes(contents).filter(node => node.type === 'Text').map(node => node.children.join('')), ['John Doe']);
  assert.equal(nodes(contents).some(node => /Remove|Restore|Invite/.test(node.props.title ?? '')), false);
  component(contents, 'CancelDialogActions').props.onCancel();
  assert.equal(nodes(render()).some(node => node.type?.name === 'PreviousMembersDialog'), false);
  assert.equal(JSON.stringify(group), before, 'participants, balances and historical records stay intact');
  group.participants = group.participants.filter(person => !person.removed);
  assert.equal(nodes(render()).some(node => node.props.label === 'Previous members'), false);
});

test('person invite shares reuse one link after missing, cancelled and successful share results', async () => {
  let result: unknown;
  let shares = 0, invites = 0;
  const app = production('MembersScreen.tsx', {
    publicAppUrl: (url: string) => url,
    Share: { sharedAction: 'sharedAction', share: async () => { shares++; return result; } },
  });
  const group: Group = { id: 'group', name: 'Trip', owner_id: 1, version: 1,
    participants: [{ id: 'self', name: 'You', user_id: 1 }, { id: 'friend', name: 'Friend', user_id: null }],
    expenses: [], settlements: [], balances: {}, transfers: [], activity: [] };
  const render = () => app.render('MemberSettings', { group, selfId: 'self', busy: false, onMembership() {},
    onAction: async () => { invites++; return { url: 'https://merosplit.com/invite/example' }; } });
  const assertNoError = (tree: Element) => assert.equal(nodes(tree).some(node => node.props.feedback?.error), false);
  try {
    nodes(render()).find(node => node.type?.name === 'MemberRow' && node.props.person.id === 'friend')!.props.onInvite();
    component(render(), 'PersonInviteDialog').props.onShare(); await tick();
    assertNoError(render());
    const retry = async () => { component(render(), 'PersonInviteDialog').props.onShare(); await tick(); assertNoError(render()); };
    await retry();
    result = { action: 'dismissedAction' }; await retry();
    assert.ok(component(render(), 'PersonInviteDialog').props.person);
    result = { action: 'sharedAction' }; await retry();
    assert.ok(component(render(), 'PersonInviteDialog').props.person);
    assert.equal(invites, 1);
    assert.equal(shares, 4);
  } finally { app.unmount(); }
});
