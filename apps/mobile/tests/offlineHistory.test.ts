import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sqliteAdapter } from './sqlite.ts';
import { migrate, saveGroup, saveDraft, reconcileGroupCache, wipeAccount, enqueue, pendingCommands, readExpenseHistory, saveExpenseHistory, confirmSync, confirmedSync } from '../src/storage.ts';
import type { ExpenseHistoryPage, ExpenseVersion } from '../src/expenseHistory.ts';
import type { Group } from '../src/types.ts';
import { accountOwner, cacheOfflineGroups } from '../src/api.ts';
import { readVisibleGroup } from '../src/storage.ts';
const owner='server|1';
const group:Group={id:'trip',name:'Trip',version:3,participants:[],expenses:[{id:'bill'} as any],settlements:[],balances:{},transfers:[],activity:[]};
const entry=(sequence:number):ExpenseVersion=>({id:String(sequence),sequence,created_at:'2026-10-24T00:00:00Z',actor_name:'Synthetic actor',names:{},currency:'INR',kind:'edited',changes:[{field:'description',before:'Old',after:'Saved'}],labels_recorded:true});
const page=(extra:Partial<ExpenseHistoryPage>={}):ExpenseHistoryPage=>({group_id:'trip',expense_id:'bill',version:3,items:[entry(21)],next_before:20,legacy_gap:false,...extra});

test('authorized version pages persist across SQLite restart; incomplete history prevents confirmation and new versions revoke the checkpoint',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'ms-history-')),file=join(dir,'cache.db');let raw=new DatabaseSync(file);
 try{
  let db=sqliteAdapter(raw);await migrate(db);await saveGroup(db,owner,group,'shared');assert.equal(await confirmSync(db,owner),false);
  await saveExpenseHistory(db,owner,'trip','bill',page());assert.equal(await confirmSync(db,owner),false);
  const complete=await saveExpenseHistory(db,owner,'trip','bill',page({items:[entry(19)],next_before:null,legacy_gap:true}),20);
  assert.deepEqual(complete.items.map(v=>v.sequence),[21,19]);assert.equal(complete.legacy_gap,true);assert.equal(await confirmSync(db,owner),true);
  raw.close();raw=new DatabaseSync(file);db=sqliteAdapter(raw);await migrate(db);
  assert.deepEqual(await readExpenseHistory(db,owner,'trip','bill',3),complete);assert.ok(await confirmedSync(db,owner));assert.equal(await readExpenseHistory(db,'server|2','trip','bill'),null);
  await wipeAccount(db,'server|2');assert.deepEqual(await readExpenseHistory(db,owner,'trip','bill'),complete);
  // A new full snapshot, not just a summary, must invalidate completion too.
  await saveGroup(db,owner,{...group,version:4},'shared');assert.equal(await readExpenseHistory(db,owner,'trip','bill'),null);assert.equal(await confirmedSync(db,owner),null);assert.equal(await confirmSync(db,owner),false);
  await assert.rejects(saveExpenseHistory(db,owner,'trip','bill',page()),/History changed/);
  await saveExpenseHistory(db,owner,'trip','bill',page({version:4,next_before:null}));assert.equal(await confirmSync(db,owner),true);
  await saveDraft(db,owner,'trip',{description:'Retained work'});await reconcileGroupCache(db,owner,[]);assert.equal(await readExpenseHistory(db,owner,'trip','bill'),null);
  assert.equal((await db.getFirstAsync<{n:number}>('SELECT count(*) AS n FROM expense_history WHERE owner=?',owner))?.n,0);assert.equal(await confirmedSync(db,owner),null);
 }finally{raw.close();rmSync(dir,{recursive:true,force:true});}
});

test('history rejects cursor gaps, repeats, wrong entities and late account generations without replacing authorized data',async()=>{
 const raw=new DatabaseSync(':memory:'),db=sqliteAdapter(raw);
 try{
  await migrate(db);await saveGroup(db,owner,group,'shared');await saveExpenseHistory(db,owner,'trip','bill',page());const before=await readExpenseHistory(db,owner,'trip','bill');
  await assert.rejects(saveExpenseHistory(db,owner,'trip','bill',page({next_before:20}),20),/unavailable/);
  await assert.rejects(saveExpenseHistory(db,owner,'trip','bill',page({items:[entry(9)],next_before:null}),10),/History changed/);
  await assert.rejects(saveExpenseHistory(db,owner,'trip','bill',page({expense_id:'other'})),/unavailable/);
  await assert.rejects(saveExpenseHistory(db,owner,'trip','bill',page({items:[entry(21),entry(21)]})),/unavailable/);
  await assert.rejects(saveExpenseHistory(db,owner,'trip','bill',page({items:[entry(19)],next_before:null}),20,()=>false),/History changed/);
  assert.deepEqual(await readExpenseHistory(db,owner,'trip','bill'),before);
  let current=true;const switched={...db,withExclusiveTransactionAsync:(task:Parameters<typeof db.withExclusiveTransactionAsync>[0])=>db.withExclusiveTransactionAsync(tx=>task({...tx,runAsync:async(sql,...args)=>{const r=await tx.runAsync(sql,...args);if(sql.startsWith('INSERT INTO expense_history'))current=false;return r;}}))};
  await assert.rejects(saveExpenseHistory(switched,owner,'trip','bill',page({items:[entry(19)],next_before:null}),20,()=>current),/account changed/);
  assert.deepEqual(await readExpenseHistory(db,owner,'trip','bill'),before);
 }finally{raw.close();}
});

test('v5 upgrade invalidates old incomplete-core checkpoints but preserves truly unsent command flags',async()=>{
 const raw=new DatabaseSync(':memory:'),db=sqliteAdapter(raw);
 try{
  await migrate(db);await enqueue(db,owner,{command_id:'unsent',group_id:'trip',method:'POST',path:'/groups',body:{id:'trip'},state:'pending',error:null});
  raw.exec("DROP TABLE expense_history; INSERT INTO sync_state VALUES('server|1','old'); PRAGMA user_version=5;");
  await migrate(db);assert.equal((await pendingCommands(db,owner))[0].attempted,undefined);assert.equal(await confirmedSync(db,owner),null);
  assert.equal((await db.getFirstAsync<{user_version:number}>('PRAGMA user_version'))?.user_version,6);
 }finally{raw.close();}
});


test('delayed full/history downloads cannot revive a group removed by a newer authorized index',async()=>{
 const original=globalThis.fetch,session={baseUrl:'https://fixture.invalid',userId:'1',email:'actor@fixture.invalid',token:'generation'},scope=accountOwner(session);
 try{
  for(const delayed of ['full','history'])for(const retained of [false,true]){
   const raw=new DatabaseSync(':memory:'),db=sqliteAdapter(raw);let release:((v:Response)=>void)|undefined;
   try{
    await migrate(db);await saveGroup(db,scope,delayed==='full'?{...group,read_mode:'summary'}:group,'shared');if(retained)await saveDraft(db,scope,'trip',{description:'Keep saved work'});
    globalThis.fetch=async url=>{const isFull=String(url).endsWith('/groups/trip');if(isFull&&delayed==='full'||!isFull&&delayed==='history')return new Promise(resolve=>{release=resolve;});return Response.json(isFull?group:page({next_before:null}));};
    const work=cacheOfflineGroups(db,session);for(let i=0;i<100&&!release;i++)await Promise.resolve();assert.ok(release);
    await reconcileGroupCache(db,scope,[]);release!(Response.json(delayed==='full'?group:page({next_before:null})));
    await assert.rejects(work,/changed/i);
    const visible=await readVisibleGroup(db,scope,'trip');assert.equal(visible?.kind,retained?'unavailable':undefined);assert.equal(await readExpenseHistory(db,scope,'trip','bill'),null);
    assert.equal((await db.getFirstAsync<{n:number}>("SELECT count(*) AS n FROM groups_cache WHERE owner=? AND kind='shared'",scope))?.n,0);assert.equal(await confirmedSync(db,scope),null);
   }finally{raw.close();}
  }
 }finally{globalThis.fetch=original;}
});
