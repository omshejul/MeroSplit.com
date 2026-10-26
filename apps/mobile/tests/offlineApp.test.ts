import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { DatabaseSync } from 'node:sqlite';
import { sqliteAdapter } from './sqlite.ts';
import { migrate, enqueue, pendingCommands } from '../src/storage.ts';
import { addPerson } from '../src/members.ts';
const file = ts.createSourceFile('App.tsx', readFileSync(new URL('../App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function declarations(name: string): ts.FunctionDeclaration[] { const result: ts.FunctionDeclaration[]=[]; function visit(node: ts.Node) { if(ts.isFunctionDeclaration(node) && node.name?.text===name) result.push(node); ts.forEachChild(node,visit); } visit(file); return result; }
function production(name: string, env: object) { const node=declarations(name)[0]; assert.ok(node); return new Function('env', `with(env) { ${ts.transpile(node.getText(file),{target:ts.ScriptTarget.ES2022})}; return ${name}; }`)(env); }

test('actual App portal siblings have stable distinct account-scoped identities', () => {
 const keys:string[]=[];
 function visit(node:ts.Node) {
  if(ts.isJsxSelfClosingElement(node) && ['UPISetupDialog','FeedbackDialog','OAuthContinuation'].includes(node.tagName.getText(file))) {
   const attr=node.attributes.properties.find(value=>ts.isJsxAttribute(value)&&value.name.getText(file)==='key') as ts.JsxAttribute;
   assert.ok(attr?.initializer && ts.isJsxExpression(attr.initializer));
   const code=(attr.initializer as ts.JsxExpression).expression!.getText(file);
   const key=new Function('owner','session',`return ${code};`)('backend|1',{token:'generation'});
   assert.match(key,/backend\|1/);assert.match(key,/generation/);keys.push(key);
  }
  ts.forEachChild(node,visit);
 }
 visit(file);assert.equal(keys.length,3);assert.equal(new Set(keys).size,3,'separate sibling portal types must never share React keys');
});

test('actual App account component keys stay distinct and remount on owner change', () => {
 const names=['ProfileSettings','AccountNotifications','AppUpdates','MCPSettings','ExportData'];
 const keys=new Map<string,(owner:string)=>string>();
 function visit(node:ts.Node) {
  if(ts.isJsxSelfClosingElement(node) && names.includes(node.tagName.getText(file))) {
   const name=node.tagName.getText(file);
   assert.equal(keys.has(name),false,`${name} must have one Account call site`);
   const attr=node.attributes.properties.find(value=>ts.isJsxAttribute(value)&&value.name.getText(file)==='key') as ts.JsxAttribute;
   assert.ok(attr?.initializer && ts.isJsxExpression(attr.initializer));
   keys.set(name,new Function('owner',`return ${(attr.initializer as ts.JsxExpression).expression!.getText(file)};`) as (owner:string)=>string);
  }
  ts.forEachChild(node,visit);
 }
 visit(file);assert.equal(keys.size,5);
 for(const owner of ['server|first','server|second']) {
  const actual=[...keys.values()].map(key=>key(owner));
  assert.equal(new Set(actual).size,5,'Account component identities must not collide');
  actual.forEach((value,index)=>{assert.ok(value.includes(owner));assert.equal(value,[...keys.values()][index](owner));});
 }
 for(const key of keys.values())assert.notEqual(key('server|first'),key('server|second'),'account change must remount every keyed component');
});

test('actual App groupAction persists offline member once and returns pending, never a forged server/link acknowledgement', async () => {
 const raw=new DatabaseSync(':memory:'),db=sqliteAdapter(raw);let sends=0;let id=0;
 try {
  await migrate(db);
  const env={session:{userId:'1'},owner:'server|1',groupId:'trip',pending:[],load:async()=>{},setSyncing(){},ownerRef:{current:'server|1'},requireConnectionForTemporaryStorage(){},perform:async(work:()=>unknown)=>work(),getDatabase:async()=>db,enqueue,pendingCommands,isOnline:()=>false,syncOutbox:async()=>{sends++;return[]},command:(method:string,path:string,body:object)=>({command_id:(body as any).command_id??`command-${id++}`,group_id:'trip',method,path,body,state:'pending',error:null}),ApiError:class extends Error{}};
  const action=production('groupAction',env);
  const input={command_id:'same-command',id:'john',name:'John',email:'test@example.invalid'};
  const result=await addPerson('trip',input,action);
  assert.deepEqual(result,{linked:false,linkedParticipantIds:[],pending:true});assert.equal(sends,0);
  assert.equal((await pendingCommands(db,'server|1')).length,1);
  await addPerson('trip',input,action);assert.equal((await pendingCommands(db,'server|1')).length,1,'same exact retry preserves one command');
  await assert.rejects(action('/participants/john/email-invite',{command_id:'mail'}),/connection/i);assert.equal(sends,0);
  assert.equal((await pendingCommands(db,'server|1')).length,1,'server-dependent actions are not silently queued offline');
 } finally {raw.close();}
});

test('actual syncAccount releases the UI action before the complete-history download finishes', async () => {
 let downloads=0;
 const active={userId:'1',token:'generation'},scope='server|1';
 const env={accountOwner:()=>scope,ownerRef:{current:scope},activeSessionRef:{current:active},activeGroupRef:{current:null},setSyncing(){},setSyncProblem(){},setVerifiedEmptyOwner(){},getDatabase:async()=>({}),readProfile:async()=>({}),request:async()=>({needs_invitation:false}),setNeedsInvitation(){},syncOutbox:async()=>[],ApiError:class extends Error{},retryAccountMediaUploads:async()=>0,setNotice(){},refreshGroups:async()=>[],load:async()=>{},setGroupId(){},setScreen(){},downloadOffline:()=>{downloads++;return new Promise(()=>{});}};
 const sync=production('runAccountRefresh',{...env,authHeldRef:{current:false}});
 await Promise.race([sync(active),new Promise((_,reject)=>setTimeout(()=>reject(new Error('History download held the UI action')),100))]);
 assert.equal(downloads,1);
});

test('actual App opens queued bill/payment previews without network or publishing pending data as accepted', async () => {
 const active={token:'generation'},group={id:'trip'},navigated:string[]=[];let expense='',payment='';
 const env={session:active,selected:{group},pending:[{body:{id:'bill'},path:'/groups/trip/expenses'},{body:{id:'payment'},path:'/groups/trip/settlements'}],perform:async(work:()=>unknown)=>work(),withBill:()=>{throw new Error('pending bill attempted server read');},withPayment:()=>{throw new Error('pending payment attempted server read');},activeSessionRef:{current:active},setExpenseId:(id:string)=>{expense=id;},setSettlementId:(id:string)=>{payment=id;},navigate:(screen:string,params:any)=>{navigated.push(screen);expense=params?.expenseId??expense;payment=params?.settlementId??payment;},saveGroup:()=>{throw new Error('pending preview persisted as accepted');}};
 await production('openBill',env)({id:'bill'}); await production('openPayment',env)('payment');
 assert.equal(expense,'bill');assert.equal(payment,'payment');assert.deepEqual(navigated,['expenseDetail','paymentDetail']);
});


test('actual App history invalidation clears Synced for its current generation only',()=>{
 let callback:ts.Expression|undefined;
 function visit(n:ts.Node){if(ts.isJsxSelfClosingElement(n)&&n.tagName.getText(file)==='ExpenseVersionHistory'){const a=n.attributes.properties.find(a=>ts.isJsxAttribute(a)&&a.name.getText(file)==='onInvalidated')as ts.JsxAttribute;assert.ok(a?.initializer&&ts.isJsxExpression(a.initializer));callback=(a.initializer as ts.JsxExpression).expression;}ts.forEachChild(n,visit);}visit(file);assert.ok(callback);
 let confirmed:unknown='old',problem=false;const ownerRef={current:'server|1'},activeSessionRef:{current:{token:string}|null}={current:{token:'generation'}};
 const env={owner:'server|1',session:{token:'generation'},ownerRef,activeSessionRef,setLastConfirmed:(v:unknown)=>{confirmed=v;},setSyncProblem:(v:boolean)=>{problem=v;}};
 const invalidate=new Function('env',`with(env){return (${callback!.getText(file)});}`)(env);invalidate();assert.equal(confirmed,null);assert.equal(problem,true);
 confirmed='newer';problem=false;activeSessionRef.current={token:'new-generation'};invalidate();assert.equal(confirmed,'newer');assert.equal(problem,false);
 activeSessionRef.current={token:'generation'};ownerRef.current='server|2';invalidate();assert.equal(confirmed,'newer');assert.equal(problem,false);
});
