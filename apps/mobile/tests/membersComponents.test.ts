import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { confirmedGroupInvite } from '../src/appLinks.ts';
import { restartForUpdate } from '../src/appUpdate.ts';
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
    ...members, confirmedGroupInvite, copyText: async () => {}, React: { Fragment: 'Fragment', createElement: (type: any, props: any, ...children: any[]) => ({ type, props: props ?? {}, children }) },
    __DEV__: false, SettingsRow: 'SettingsRow', Platform: { OS: 'native' }, View: 'View', Text: 'Text', Pressable: 'Pressable', Button: 'Button', Avatar: 'Avatar', Icon: 'Icon', IconAction: 'IconAction',
    Disclosure: 'Disclosure', EmailField: 'EmailField', TextField: 'TextField', GroupMembershipActions: 'GroupMembershipActions', KeyboardDialog: 'KeyboardDialog', SendInviteDialog: 'SendInviteDialog',
    LoadingSpinner: 'LoadingSpinner', DialogFocus: 'DialogFocus', DialogScrollBody: 'DialogScrollBody', CancelDialogActions: 'CancelDialogActions', ErrorText: 'ErrorText', Dialog: Object.assign(() => {}, { Title: 'Dialog.Title' }),
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


test('guest name edit waits for confirmation, preserves failed draft and retries one command', async () => {
  let resolve!: (value: any) => void, reject!: (error: Error) => void;
  const panel = settings(false, async () => new Promise((yes, no) => { resolve = yes; reject = no; }));
  let tree = await panel.add('');
  const member = nodes(tree).find(node => node.type?.name === 'MemberRow' && node.props.person.id !== 'self')!;
  member.props.onRename(); tree = panel.render();
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
    nodes(tree).find(node => node.type?.name === 'MemberRow' && node.props.person.id !== 'self')!.props.onRename();
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
  button(tree,'Add person').props.onPress();tree=render();
  nodes(tree).find(n=>n.props.label==='Person 1')!.props.onChangeText('Noor');
  nodes(tree).find(n=>n.props.label==='Person 1 email (optional)')!.props.onChangeText('noor@example.invalid');
  tree=render();button(tree,'Create group').props.onPress();assert.deepEqual(output[1].emails,['noor@example.invalid']);
  button(tree,'Remove person 1').props.onPress();tree=render();button(tree,'Create group').props.onPress();assert.deepEqual(output[2].people,[]);app.unmount();
});

test('group invite preview never joins automatically; explicit duplicate presses join once', async () => {
  const calls:any[]=[],joined:string[]=[];let finish!: (value:any)=>void;
  const app=production('GroupJoinDialog.tsx',{request:async(_s:any,path:string,_m:string,body:any)=>{calls.push({path,body});if(path.endsWith('preview'))return{name:'Trip',already_member:false};return new Promise(r=>{finish=r;});}});
  const props={session:{token:'account-A',email:'a@example.invalid'},token:'synthetic-capability',onJoined:async(id:string)=>{joined.push(id);},onCancel(){}};
  const render=()=>app.render('GroupJoinDialog',props);render();await app.commit();let tree=render();
  assert.equal(calls.length,1);assert.equal(button(tree,'Join group').props.disabled,false);
  button(tree,'Join group').props.onPress();button(tree,'Join group').props.onPress();await tick();assert.equal(calls.length,2);
  finish({id:'group'});await tick();assert.deepEqual(joined,['group']);app.unmount();
});

test('group join completion after account-scope unmount cannot open another account group', async () => {
  let finish!:(v:any)=>void;let joined=0;
  const app=production('GroupJoinDialog.tsx',{request:async(_s:any,p:string)=>p.endsWith('preview')?{name:'Trip',already_member:false}:new Promise(r=>{finish=r;})});
  const props={session:{token:'account-A',email:'a@example.invalid'},token:'synthetic',onJoined:async()=>{joined++;},onCancel(){}};
  app.render('GroupJoinDialog',props);await app.commit();button(app.render('GroupJoinDialog',props),'Join group').props.onPress();await tick();app.unmount();finish({id:'group'});await tick();assert.equal(joined,0);
});

test('uncertain group link receipt is not shareable and retries the same command', async () => {
 let accepted=false;
 const panel=settings(false,async(path,body)=>path==='/invite-link'&&accepted?{id:'group',version:2,url:'https://merosplit.com/j/'+'a'.repeat(32)}:{});
 let tree=panel.render();button(tree,'Copy link').props.onPress();await tick();tree=panel.render();
 assert.equal(nodes(tree).some(n=>n.props.title==='Share link'),false);
 accepted=true;button(tree,'Copy link').props.onPress();await tick();
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
  button(members.render('MemberSettings', props), 'Copy link').props.onPress(); await tick();
  button(members.render('MemberSettings', props), 'Copy link').props.onPress(); await tick();
  assert.equal(ids, 1); assert.deepEqual(writes.map(v => v.command_id), ['lazy-1', 'lazy-1']); members.unmount();
  const joins: any[] = [];
  const dialog = production('GroupJoinDialog.tsx', { Crypto: crypto, request: async (_session: any, path: string, _method: string, body: any) => { if (path.endsWith('preview')) return { name: 'Trip', already_member: false }; joins.push(body); throw Error('Unknown response'); } });
  const joinProps = { session: { token: 'account-a', email: 'a@example.invalid' }, token: 'synthetic', onJoined: async () => {}, onCancel() {} };
  dialog.render('GroupJoinDialog', joinProps); await dialog.commit(); dialog.render('GroupJoinDialog', joinProps); assert.equal(ids, 1);
  for (let i = 0; i < 2; i++) { button(dialog.render('GroupJoinDialog', joinProps), 'Join group').props.onPress(); await tick(); }
  assert.equal(ids, 2); assert.deepEqual(joins.map(v => v.command_id), ['lazy-2', 'lazy-2']); dialog.unmount();
});


test('Copy link uses the platform helper, exposes no URL and reports clipboard failure truthfully', async () => {
 for(const platform of ['native','web']) {
  let fail=true; const copied:string[]=[], commands:string[]=[];
  const url='https://merosplit.com/j/'+'b'.repeat(32);
  const app=production('MembersScreen.tsx',{Platform:{OS:platform},copyText:async(value:string)=>{copied.push(value);if(fail)throw Error(url);}});
  const group:Group={id:'group',name:'Trip',owner_id:1,version:2,participants:[{id:'self',name:'You',user_id:1}],expenses:[],settlements:[],balances:{},transfers:[],activity:[]};
  const props={group,selfId:'self',busy:false,onMembership(){},onAction:async(_path:string,body:any)=>{commands.push(body.command_id);return{id:'group',version:2,url};}};
  button(app.render('MemberSettings',props),'Copy link').props.onPress();await tick();
  let tree=app.render('MemberSettings',props);
  assert.equal(component(tree,'FeedbackNote').props.feedback.text,'Could not copy link. Try again.');
  assert.ok(!JSON.stringify(tree).includes(url));
  fail=false;button(tree,'Copy link').props.onPress();await tick();tree=app.render('MemberSettings',props);
  assert.deepEqual(copied,[url,url]);assert.equal(commands[0],commands[1]);
  assert.equal(component(tree,'FeedbackNote').props.feedback.text,'Link copied');
  assert.ok(!JSON.stringify(tree).includes(url));assert.equal(nodes(tree).some(n=>n.props.title==='Share link'),false);
  app.unmount();
 }
});


function updateModule() {
 const calls:string[]=[], state:any={currentlyRunning:{isEmergencyLaunch:false},isUpdatePending:false,isUpdateAvailable:false};
 const module:any={isEnabled:true,runtimeVersion:'native-fingerprint',channel:'merosplit-1-1-testing',UpdateInfoType:{ROLLBACK:'rollback'},useUpdates:()=>state,
  checkForUpdateAsync:async()=>{calls.push('check');return{isAvailable:true,isRollBackToEmbedded:false};},
  fetchUpdateAsync:async()=>{calls.push('download');return{isNew:true,isRollBackToEmbedded:false};},reloadAsync:async()=>{calls.push('reload');}};
 return {module,state,calls};
}

test('updates never check on mount; Check, Download and Restart are separate explicit actions', async () => {
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


test('an empty download clears the stale available action and permits an explicit recheck', async () => {
 const native=updateModule();native.state.isUpdateAvailable=true;native.module.fetchUpdateAsync=async()=>({isNew:false,isRollBackToEmbedded:false});
 const app=production('AppUpdates.tsx',{Updates:native.module});
 const props={busy:false,online:true,onRestart:async()=>{assert.fail();}};
 button(app.render('AppUpdates',props),'Download').props.onPress();await tick();
 const tree=app.render('AppUpdates',props);assert.ok(button(tree,'Check'));assert.equal(button(tree,'Restart'),undefined);
 assert.ok(JSON.stringify(tree).includes('No update was downloaded.'));app.unmount();
});
