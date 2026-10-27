import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';
import { accountOwner, refreshGroups } from '../src/api.ts';
import { storageRevision, migrate, saveGroup, readVisibleGroup, listGroups, pendingCommands, listLegacyGroups, listLegacyRecoveries, listUnavailableGroups, confirmedSync } from '../src/storage.ts';
import { listPaymentReturns } from '../src/paymentReturnStorage.ts';
import { sqliteAdapter } from './sqlite.ts';
import type { Group, Session } from '../src/types.ts';
const session: Session = { baseUrl:'https://synthetic.invalid', userId:'1', email:'one@example.invalid', token:'one' };
const owner = accountOwner(session);
const source = ts.createSourceFile('App.tsx',readFileSync(new URL('../App.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true);
function production(name: string, env: any) {
  let code=''; function visit(n: ts.Node) { if(ts.isFunctionDeclaration(n)&&n.name?.text===name)code=n.getText(source);ts.forEachChild(n,visit); } visit(source);assert.ok(code);
  return new Function('env',`with(env){${ts.transpile(code,{target:ts.ScriptTarget.ES2022})};return ${name};}`)(env);
}
const group=(id='g',version=1):Group=>({id,version,name:'Reuben',attribution_version:1,participants:[],expenses:[],settlements:[],activity:[],transfers:[],balances:{}});

test('concurrent refresh triggers share one operation and a full refresh follows a targeted one once',async()=>{
 let calls=0,finish!:()=>void;
 const env:any={accountOwner,scopeGeneration:{current:0},accountRefresh:{current:null},runAccountRefresh:()=>{calls++;return new Promise<void>(resolve=>finish=resolve);}};
 env.syncAccount=production('syncAccount',env);
 const a=env.syncAccount(session),b=env.syncAccount(session,['g']),c=env.syncAccount(session);
 assert.equal(a,b);assert.equal(a,c);assert.equal(calls,1);finish();await a;
 const targeted=env.syncAccount(session,['g']),full=env.syncAccount(session),fullAgain=env.syncAccount(session);
 assert.equal(calls,2);finish();await targeted;await Promise.resolve();assert.equal(calls,3);
 finish();await Promise.all([full,fullAgain]);assert.equal(calls,3);
});

test('targeted refresh fetches only changed notice groups while reconciling revoked membership',async()=>{
 const original=globalThis.fetch,raw=new DatabaseSync(':memory:'),db=sqliteAdapter(raw),calls:string[]=[];
 try{
  await migrate(db);for(const id of ['g','unrelated','revoked'])await saveGroup(db,owner,group(id),'shared');
  globalThis.fetch=async url=>{const path=new URL(String(url)).pathname;calls.push(path);return Response.json(path.endsWith('/groups')?{groups:[{id:'g',version:2},{id:'unrelated',version:2}]}:group('g',2));};
  assert.deepEqual(await refreshGroups(db,session,'full',undefined,{groupIds:['g'],current:()=>true}),['revoked']);
  assert.deepEqual(calls,['/api/v1/groups','/api/v1/groups/g']);
  assert.equal((await readVisibleGroup(db,owner,'unrelated'))?.group.version,1);
  assert.equal((await readVisibleGroup(db,owner,'revoked')),null);
  let current=true;globalThis.fetch=async url=>{if(String(url).endsWith('/groups'))return Response.json({groups:[{id:'g',version:3}]});current=false;return Response.json(group('g',3));};
  await assert.rejects(refreshGroups(db,session,'full',undefined,{current:()=>current}),/account changed/);
  assert.equal((await readVisibleGroup(db,owner,'g'))?.group.version,2);
 }finally{raw.close();globalThis.fetch=original;}
});

test('unchanged persisted data publishes once; failed refresh and stale loads retain visible records',async()=>{
 const raw=new DatabaseSync(':memory:'),db=sqliteAdapter(raw);let shown:any[]=[],publishes=0;
 const setter=()=>{};
 const env:any={ownerRef:{current:owner},activeGroupRef:{current:'g'},getDatabase:async()=>db,isOnline:()=>true,
  publishedStorage:{current:{scope:'',view:'',changes:-1}},loadGeneration:{current:0},groupVersions:{current:''},activityOwner:{current:''},
  storageRevision,listGroups,pendingCommands,listLegacyGroups,listLegacyRecoveries,listUnavailableGroups,listPaymentReturns,confirmedSync,
  setLastConfirmed:setter,setPendingFiles:setter,setActivity:setter,setGroups:(fn:any)=>{const next=fn(shown);if(next!==shown)publishes++;shown=next;},setCommands:setter,setLegacy:setter,setRecoveries:setter,setUnavailable:setter,setHasDrafts:setter,setReturns:setter};
 try{
  await migrate(db);await saveGroup(db,owner,group(),'shared');const load=production('load',env);
  await load();assert.equal(publishes,1);const first=shown[0];await load();assert.equal(publishes,1);
  await saveGroup(db,owner,group(),'shared');await load();assert.equal(shown[0],first);assert.equal(publishes,1);
  await saveGroup(db,owner,group('g',2),'shared');await load();assert.equal(shown[0].group.version,2);assert.equal(publishes,2);
 }finally{raw.close();}
});

test('storage revisions detect native-style commits on a separate SQLite connection',async()=>{
 const {mkdtempSync,rmSync,mkdirSync}=await import('node:fs'),{join}=await import('node:path'),{homedir}=await import('node:os');
 const parent=join(homedir(),'.codex','tmp');mkdirSync(parent,{recursive:true});const folder=mkdtempSync(join(parent,'sync-revision-'));
 const raw=new DatabaseSync(join(folder,'db.sqlite')),db=sqliteAdapter(raw),writer=new DatabaseSync(join(folder,'db.sqlite'));
 try{
  await migrate(db);const first=await storageRevision(db);writer.exec("INSERT INTO sync_state VALUES('owner','confirmed')");
  const second=await storageRevision(db);assert.notEqual(second,first);
  assert.equal(await storageRevision(db),second,'reads alone never cause a publish');
  await db.runAsync("DELETE FROM sync_state WHERE owner='owner'");assert.notEqual(await storageRevision(db),second);
 }finally{writer.close();raw.close();rmSync(folder,{recursive:true,force:true});}
});


test('a new client scope generation does not rejoin the prior same-token refresh', async () => {
 const finishes: (() => void)[] = [];
 const env: any = { accountOwner, scopeGeneration: { current: 0 }, accountRefresh: { current: null }, runAccountRefresh: () => new Promise<void>(resolve => finishes.push(resolve)) };
 const sync = production('syncAccount', env), old = sync(session);
 ++env.scopeGeneration.current; const current = sync(session); assert.notEqual(old, current); assert.equal(finishes.length, 2);
 finishes[0](); await old; assert.equal(env.accountRefresh.current.promise, current, 'old finally must not clear the replacement job');
 finishes[1](); await current; assert.equal(env.accountRefresh.current, null);
});
