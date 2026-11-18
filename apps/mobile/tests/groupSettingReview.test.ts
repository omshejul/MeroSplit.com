import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { groupSettingReview, resolveGroupSetting, isGroupSetting } from '../src/groupSettingReview.ts';
import { migrate, enqueue, pendingCommands, saveGroup } from '../src/storage.ts';
import { accountOwner, syncOutbox } from '../src/api.ts';
import { sqliteAdapter } from './sqlite.ts';
import type { Command, Group, Session } from '../src/types.ts';
const session:Session={token:'synthetic',userId:'1',email:'qa@example.invalid',baseUrl:'https://synthetic.invalid'}, owner=accountOwner(session);
const group:Group={id:'g',name:'Trip',version:4,participants:[{id:'a',name:'A'}],expenses:[],settlements:[],activity:[],balances:{},transfers:[],simplify_debts:true,can_change_simplify:true};
const setting:Command={command_id:'setting',group_id:'g',path:'/groups/g/simplify',method:'POST',body:{command_id:'setting',version:1,simplify_debts:false},state:'conflict',error:'Group changed',attempted:true};
const bill:Command={command_id:'bill',group_id:'g',path:'/groups/g/expenses',method:'POST',body:{command_id:'bill',id:'bill',description:'Saved bill'},state:'pending',error:null};
for(const apply of [true,false])test(`reviewed setting ${apply?'replacement':'dismissal'} retains waiting bills, account scope and ordering`,async()=>{
 const raw=new DatabaseSync(':memory:'),db=sqliteAdapter(raw),fetch=globalThis.fetch,calls:string[]=[];
 try{await migrate(db);await saveGroup(db,owner,group,'shared');await enqueue(db,owner,setting);await enqueue(db,owner,bill);await enqueue(db,'foreign',setting);
 await resolveGroupSetting(db,owner,setting,group,apply?'reviewed':null);
 const rows=await pendingCommands(db,owner);assert.deepEqual(rows.map(r=>r.command_id),apply?['reviewed','bill']:['bill']);assert.deepEqual(rows.at(-1)?.body,bill.body);
 if(apply){assert.deepEqual(rows[0].body,{...setting.body,command_id:'reviewed',version:4});assert.equal(rows[0].attempted,undefined);}
 assert.equal((await pendingCommands(db,'foreign'))[0].state,'conflict');
 globalThis.fetch=async(url,options)=>{if(options?.method==='POST'){calls.push(JSON.parse(String(options.body)).command_id);return Response.json({id:'g',version:5});}return Response.json(group);};
 await syncOutbox(db,session);assert.deepEqual(calls,apply?['reviewed','bill']:['bill']);assert.equal((await pendingCommands(db,owner)).length,0);
 await assert.rejects(resolveGroupSetting(db,owner,setting,group,'stale'),'resolved work cannot be recreated from a stale review screen');
 }finally{globalThis.fetch=fetch;raw.close();}
});
test('a stale setting is sent once and waits for review across sync attempts', async () => {
  const raw = new DatabaseSync(':memory:'), db = sqliteAdapter(raw), originalFetch = globalThis.fetch;
  const sent: unknown[] = [];
  try {
    await migrate(db);
    await enqueue(db, owner, { ...setting, state: 'pending', attempted: false, error: null });
    await enqueue(db, owner, bill);
    globalThis.fetch = async (_url, options) => {
      sent.push(JSON.parse(String(options?.body)));
      return Response.json({ detail: 'This setting changed.' }, { status: 409 });
    };
    await assert.rejects(syncOutbox(db, session), /setting changed/);
    await assert.rejects(syncOutbox(db, session), /Review the earlier saved change/);
    assert.deepEqual(sent, [setting.body]);
    assert.deepEqual((await pendingCommands(db, owner)).map(row => row.state), ['conflict', 'pending']);
  } finally {
    globalThis.fetch = originalFetch;
    raw.close();
  }
});
test('unavailable or foreign settings cannot apply and arbitrary financial commands cannot retry as settings',()=>{
 assert.equal(groupSettingReview(setting,{...group,archived:true})?.canApply,false);assert.equal(groupSettingReview(setting,{...group,can_change_simplify:false})?.canApply,false);
 assert.equal(groupSettingReview(setting,{...group,id:'other'}),null);assert.equal(isGroupSetting(bill),false);assert.equal(isGroupSetting({...setting,path:'/groups/g/settlements'}),false);assert.equal(isGroupSetting({...setting,path:'/groups/other/simplify'}),false);
});
