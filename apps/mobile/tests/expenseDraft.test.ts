import { currencySymbol } from '../src/currency.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';
import { sqliteAdapter } from './sqlite.ts';
import { migrate, readDraft, saveDraft } from '../src/storage.ts';
import * as accounting from '../src/accounting.ts';

const group: any = { id:'group-one', name:'Trip', version:1, participants:[{id:'self',name:'You'},{id:'other',name:'Other'}],expenses:[],settlements:[],balances:{},transfers:[],activity:[] };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const draftModule = new URL('../src/expenseDraft.ts', import.meta.url);
const persistence = existsSync(draftModule) ? await import(draftModule.href) : {};
function form(db: any, options: any = {}) {
  let cursor=0; const state:any[]=[], deps:any[][]=[], cleanup:any[]=[], effects:(()=>void)[]=[];
  const writes={current:Promise.resolve()}, discard={current:null as null|(()=>Promise<boolean>)};
  const media:any[]=[], saves:any[]=[];
  const env:any={currencySymbol,...accounting,...persistence, React:{createElement:(type:any,props:any,...children:any[])=>({type,props:props||{},children})},
    useState:(initial:any)=>{const id=cursor++;if(!(id in state))state[id]=typeof initial==='function'?initial():initial;return[state[id],(v:any)=>{state[id]=typeof v==='function'?v(state[id]):v}]},
    useRef:(initial:any)=>{const id=cursor++;return state[id]??={current:initial}},
    useContext:()=>discard, ScreenDraftDiscard:{},
    useEffect:(fn:()=>any, values:any[])=>{const id=cursor++;if(!deps[id]||values.some((v,i)=>v!==deps[id][i])){effects.push(()=>{cleanup[id]?.();cleanup[id]=fn()});deps[id]=values}},
    StyleSheet:{create:(v:any)=>v},View:'View',Text:'Text',Form:'Form',AmountField:'AmountField',TextField:'TextField',DateField:'DateField',Button:'Button',ErrorText:'ErrorText',BillPeople:'BillPeople',DraftAttachment:'DraftAttachment',Checkbox:{Item:'Checkbox'},RadioChoice:'RadioChoice',
    useUI:()=>({ui:{}}),Crypto:{randomUUID:()=> 'draft-fixed-id'},useScreenRemovalLock:()=>{}, getDatabase:async()=>db,readDraft,saveDraft,
    clearStagedMedia:async(f:any)=>{media.push(f)},
  };
  const source=ts.createSourceFile('ExpenseForm.tsx',readFileSync(new URL('../src/ExpenseForm.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  const body=source.statements.filter(n=>!ts.isImportDeclaration(n)).map(n=>n.getText(source).replace(/^export (?:default )?/, '')).join('\n');
  const component=new Function('env',`with(env){${ts.transpile(body,{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React})};return ExpenseForm;}`)(env);
  const props={group,selfId:'self',owner:'account-a',writes,busy:false,onSave:async(...args:any[])=>{saves.push(args);args[2]?.()},...options};
  const render=()=>{cursor=0;return component(props)};
  const settle=async()=>{for(let i=0;i<5;i++){render();effects.splice(0).forEach(fn=>fn());await tick()}return render()};
  return {render,settle,writes,discard,media,saves,unmount:()=>cleanup.forEach(fn=>fn?.())};
}
function field(tree:any,type:string,label:string):any {if(tree?.type===type&&tree.props.label===label)return tree;if(Array.isArray(tree)){for(const x of tree){const r=field(x,type,label);if(r)return r}}else for(const x of tree?.children??[]){const r=field(x,type,label);if(r)return r}return null;}

test('actual new bill field callbacks survive background/unmount and real SQLite cold remount',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'merosplit-draft-')),file=join(dir,'draft.sqlite');let raw=new DatabaseSync(file);let db=sqliteAdapter(raw);await migrate(db);
  const app=form(db);let tree=await app.settle();field(tree,'AmountField','Amount (₹)').props.onChangeText('31');tree=app.render();field(tree,'TextField','Description').props.onChangeText('Cold launch draft');await app.writes.current;
  const stored=await readDraft<any>(db,'account-a','group-one');assert.equal(stored?.amount,'31','unsaved bill must reach SQLite before background or process death');assert.equal(stored?.description,'Cold launch draft');app.unmount();raw.close();
  raw=new DatabaseSync(file);db=sqliteAdapter(raw);const cold=form(db);tree=await cold.settle();assert.equal(field(tree,'AmountField','Amount (₹)').props.value,'31');assert.equal(field(tree,'TextField','Description').props.value,'Cold launch draft');assert.equal(cold.saves.length,0,'restoring must not enqueue financial writes');cold.unmount();raw.close();rmSync(dir,{recursive:true,force:true});
});

const snapshot = (changes:any={}) => ({schemaVersion:1,groupId:group.id,expenseId:null,id:'draft-fixed-id',expenseVersion:0,description:'Draft',amount:'31',date:'2026-10-27',notes:'Keep these notes',payerIds:['self'],payerAmounts:{self:'31'},mode:'shares',participantIds:['self','other'],splitValues:{self:'2',other:'1'},...changes});
const memory = async () => {const raw=new DatabaseSync(':memory:'),db=sqliteAdapter(raw);await migrate(db);return{raw,db}};
const button = (tree:any,title:string):any => {if(tree?.type==='Button'&&tree.props.title===title)return tree;if(Array.isArray(tree)){for(const x of tree){const r=button(x,title);if(r)return r}}else for(const x of tree?.children??[]){const r=button(x,title);if(r)return r}return null};

test('account, group and new/edit scopes retain independent complete drafts and split modes',async()=>{
 const {raw,db}=await memory(),writes={current:Promise.resolve()};
 const make=(owner='a',id='group-one',bill:string|null=null)=>persistence.expenseDraftStore(owner,id,bill,writes,async()=>db);
 await make().write(snapshot());await make('b').write(snapshot({description:'Another account'}));await make('a','group-two').write(snapshot({groupId:'group-two',description:'Another group'}));await make('a','group-one','saved-bill').write(snapshot({id:'saved-bill',expenseId:'saved-bill',mode:'exact',splitValues:{self:'21',other:'10'}}));
 assert.deepEqual(await make().read(),snapshot());assert.equal((await make('b').read())?.description,'Another account');assert.equal((await make('a','group-two').read())?.description,'Another group');assert.equal((await make('a','group-one','saved-bill').read())?.mode,'exact');raw.close();
});

test('deferred database acquisition serializes writes and cannot resurrect a discarded draft',async()=>{
 const {raw,db}=await memory(),writes={current:Promise.resolve()};let release!:()=>void;const gate=new Promise<void>(r=>release=r);let reads=0;
 const store=persistence.expenseDraftStore('a',group.id,null,writes,async()=>{if(++reads===1)await gate;return db});
 const first=store.write(snapshot({amount:'3'}));await tick();const second=store.write(snapshot({amount:'31'}));const discard=store.write(null);release();await Promise.all([first,second,discard]);assert.equal(await readDraft(db,'a',group.id),null);
 const value=snapshot();const saving=store.write(value);value.amount='999';await saving;assert.equal((await store.read())?.amount,'31','queued writes snapshot their own revision');raw.close();
});

test('a late hydration read never overwrites a newer draft revision',async()=>{
 const {raw,db}=await memory(),writes={current:Promise.resolve()};await saveDraft(db,'a',group.id,snapshot({amount:'3'}));let release!:()=>void;const gate=new Promise<void>(r=>release=r);
 const delayed={...db,getFirstAsync:async<T>(sql:string,...args:any[])=>{const row=await db.getFirstAsync<T>(sql,...args);if(sql.startsWith('SELECT body'))await gate;return row}};
 const store=persistence.expenseDraftStore('a',group.id,null,writes,async()=>delayed);const loading=store.read();await tick();await store.write(snapshot({amount:'31'}));release();assert.equal(await loading,null);assert.equal((await store.read())?.amount,'31');raw.close();
});

test('normal unmount retains owned attachment, explicit discard removes only that scoped draft and file',async()=>{
 const {raw,db}=await memory();const attachment={id:'file-one',path:'/groups/group-one/expenses/draft-fixed-id/attachments',file:{uri:'file:///synthetic/merosplit-upload-file-one.pdf',name:'Draft.pdf',type:'application/pdf',size:4}};
 await saveDraft(db,'account-a',group.id,snapshot({attachment}));await saveDraft(db,'account-b',group.id,snapshot({description:'Keep account B'}));
 const first=form(db);await first.settle();first.unmount();await tick();assert.equal(first.media.length,0);assert.deepEqual((await readDraft<any>(db,'account-a',group.id))?.attachment,attachment);
 const second=form(db);await second.settle();assert.equal(await second.discard.current?.(),true);assert.equal(await readDraft(db,'account-a',group.id),null);assert.equal((await readDraft<any>(db,'account-b',group.id))?.description,'Keep account B');assert.deepEqual(second.media,[attachment.file]);second.unmount();raw.close();
});

test('save clears only after durable handoff and duplicate taps cannot enqueue twice',async()=>{
 const {raw,db}=await memory();await saveDraft(db,'account-a',group.id,snapshot({mode:'equal',splitValues:{}}));
 const app=form(db);const tree=await app.settle();const save=button(tree,'Save bill');save.props.onPress();save.props.onPress();await tick();await app.writes.current;assert.equal(app.saves.length,1);assert.equal(await readDraft(db,'account-a',group.id),null);app.unmount();raw.close();
});

test('a failed bill save preserves draft and attachment for the next cold mount',async()=>{
 const {raw,db}=await memory();await saveDraft(db,'account-a',group.id,snapshot({mode:'equal',splitValues:{}}));const app=form(db,{onSave:async()=>{throw Error('Synthetic queue failure')}});const tree=await app.settle();button(tree,'Save bill').props.onPress();await tick();await app.writes.current;assert.equal((await readDraft<any>(db,'account-a',group.id))?.amount,'31');app.unmount();assert.equal(app.media.length,0);raw.close();
});

test('a malformed or mismatched persisted scope is retained and blocks unsafe restore',async()=>{
 const {raw,db}=await memory(),writes={current:Promise.resolve()};await saveDraft(db,'a',group.id,snapshot({groupId:'other-group'}));const store=persistence.expenseDraftStore('a',group.id,null,writes,async()=>db);await assert.rejects(store.read(),/Could not restore/);assert.equal((await readDraft<any>(db,'a',group.id))?.groupId,'other-group');raw.close();
});

test('SQLite persistence failure keeps prior draft and the next revision can recover without financial commands',async()=>{
 const {raw,db}=await memory();await saveDraft(db,'a',group.id,snapshot({amount:'3'}));let fail=true;const failing={...db,runAsync:async(sql:string,...args:any[])=>{if(fail&&sql.startsWith('INSERT INTO drafts')){fail=false;throw Error('Synthetic storage failure')}return db.runAsync(sql,...args)}};
 const store=persistence.expenseDraftStore('a',group.id,null,{current:Promise.resolve()},async()=>failing);await assert.rejects(store.write(snapshot({amount:'31'})),/Synthetic/);assert.equal((await readDraft<any>(db,'a',group.id))?.amount,'3');await store.write(snapshot({amount:'32'}));assert.equal((await store.read())?.amount,'32');assert.equal((await db.getFirstAsync<{n:number}>('SELECT count(*) AS n FROM outbox'))?.n,0);raw.close();
});

test('actual navigation Cancel preserves draft; Discard waits for its own persistence and honors failure',async()=>{
 const source=ts.createSourceFile('AppStack.tsx',readFileSync(new URL('../src/AppStack.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 const handlers:any={};function visit(node:ts.Node){if(ts.isJsxOpeningElement(node)||ts.isJsxSelfClosingElement(node)){
  const tag=node.tagName.getText(source),attrs=node.attributes.properties.filter(ts.isJsxAttribute);const get=(name:string)=>attrs.find(a=>a.name.getText(source)===name)?.initializer;
  if(tag==='CancelDialogActions'){const value=get('onCancel');if(value&&ts.isJsxExpression(value))handlers.cancel=value.expression!.getText(source)}
  if(tag==='Button'&&get('title')?.getText(source)==='"Discard"'){const value=get('onPress');if(value&&ts.isJsxExpression(value))handlers.discard=value.expression!.getText(source)}
 }ts.forEachChild(node,visit)}visit(source);
 assert(handlers.cancel&&handlers.discard);const actions:any[]=[],clears:any[]=[];let release!:(value:boolean)=>void;
 const env={pending:{type:'GO_BACK'},blocked:false,localBlocked:false,discardLock:{current:false},setDiscarding(){},navigation:{isFocused:()=>true,dispatch:(v:any)=>actions.push(v)},setPending:(v:any)=>clears.push(v),draftDiscard:{current:()=>new Promise<boolean>(r=>release=r)}};
 const bind=(name:string)=>new Function('env',`with(env){${ts.transpile('const handler = '+handlers[name],{target:ts.ScriptTarget.ES2022})};return handler;}`)(env);
 bind('cancel')();assert.equal(actions.length,0);assert.equal(clears.length,1);bind('discard')();await tick();assert.equal(actions.length,0,'navigation must wait for SQLite discard');release(false);await tick();assert.equal(actions.length,0,'failed discard must retain form');bind('discard')();await tick();release(true);await tick();assert.equal(actions.length,1);
});

test('actual field revisions remain durable when SQLite is deferred across background and cold remount',async()=>{
 const {raw,db}=await memory();let release!:()=>void;const gate=new Promise<void>(r=>release=r);let held=false;
 const deferred={...db,runAsync:async(sql:string,...args:any[])=>{if(!held&&sql.startsWith('INSERT INTO drafts')){held=true;await gate}return db.runAsync(sql,...args)}};
 const app=form(deferred);let tree=await app.settle();field(tree,'AmountField','Amount (₹)').props.onChangeText('3');await tick();tree=app.render();field(tree,'AmountField','Amount (₹)').props.onChangeText('31');tree=app.render();field(tree,'TextField','Description').props.onChangeText('Deferred draft');app.unmount();release();await app.writes.current;
 assert.equal((await readDraft<any>(db,'account-a',group.id))?.amount,'31','latest form revision must reach real SQLite despite background');const cold=form(db);tree=await cold.settle();assert.equal(field(tree,'AmountField','Amount (₹)').props.value,'31');assert.equal(field(tree,'TextField','Description').props.value,'Deferred draft');assert.equal(cold.saves.length,0);cold.unmount();raw.close();
});


test('a stale discard callback cannot remove a file after its durable queue handoff', async () => {
  const {raw,db} = await memory();
  const attachment = {id:'owned',path:'/groups/group-one/expenses/draft-fixed-id/attachments',file:{uri:'file:///synthetic/queued.pdf',name:'queued.pdf',type:'application/pdf',size:4}};
  await saveDraft(db,'account-a',group.id,snapshot({mode:'equal',splitValues:{},attachment}));
  const app = form(db,{onSave:async (_value:any,_file:any,onQueued:()=>void) => { onQueued(); throw Error('Refresh failed after queue commit'); }});
  const tree = await app.settle(); button(tree,'Save bill').props.onPress(); await tick(); await app.writes.current;
  assert.equal(await app.discard.current?.(),true); assert.equal(app.media.length,0,'the durable queue now owns the bytes');
  app.unmount(); raw.close();
});
