import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sqliteAdapter } from './sqlite.ts';
import { migrate, readDraft } from '../src/storage.ts';
import { defaultExpenseChoices, defaultPayerAmounts, readExpenseDefaults, saveExpenseDefaults, validateExpenseDefaults } from '../src/expenseDefaults.ts';
import type { ExpenseDefaults } from '../src/expenseDefaults';
import type { Group } from '../src/types';
const group={id:'g',participants:[{id:'a',name:'Asha'},{id:'b',name:'Bea'},{id:'c',name:'Chen',removed:true}]} as Group;
const preset:ExpenseDefaults={payerIds:['a','b'],participantIds:['a','b'],allParticipants:true,mode:'percent',splitValues:{a:'40',b:'60'}};

test('defaults survive real SQLite close/reopen and remain scoped to account and ledger',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'bill-defaults-')),file=join(dir,'test.sqlite');let raw=new DatabaseSync(file),db=sqliteAdapter(raw);
 try {
  await migrate(db);await saveExpenseDefaults(db,'account-a','g',preset);raw.close();raw=new DatabaseSync(file);db=sqliteAdapter(raw);await migrate(db);
  assert.deepEqual(await readExpenseDefaults(db,'account-a','g'),preset);
  assert.equal(await readExpenseDefaults(db,'account-b','g'),null);assert.equal(await readExpenseDefaults(db,'account-a','personal-ledger'),null);
  assert.equal(await readDraft(db,'account-a','g'),null,'preferences never create an expense draft');
  await saveExpenseDefaults(db,'account-a','personal-ledger',{...preset,payerIds:['b']});await saveExpenseDefaults(db,'account-a','g',null);
  assert.equal(await readExpenseDefaults(db,'account-a','g'),null);assert.deepEqual((await readExpenseDefaults(db,'account-a','personal-ledger'))?.payerIds,['b']);
  assert.equal((await db.getFirstAsync<{user_version:number}>('PRAGMA user_version'))?.user_version,6,'older OTAs can still open this schema');
 } finally {raw.close();rmSync(dir,{recursive:true,force:true});}
});
test('membership changes remove stale people and safely recover empty selections and percentages',()=>{
 const changed={...group,participants:[{id:'a',name:'Asha',removed:true},{id:'b',name:'Bea'},{id:'d',name:'Dev'}]} as Group;
 const next=defaultExpenseChoices(changed,'b',preset);assert.deepEqual(next.payerIds,['b']);assert.deepEqual(next.participantIds,['b','d']);assert.equal(next.mode,'equal');
 const subset=defaultExpenseChoices(changed,'b',{...preset,allParticipants:false,payerIds:['a'],participantIds:['a']});assert.deepEqual(subset.payerIds,['b']);assert.deepEqual(subset.participantIds,['b','d']);assert.equal(subset.mode,'equal');
 const direct=defaultExpenseChoices({...group,is_direct:true},'a',{...preset,payerIds:['b'],allParticipants:false,participantIds:['a'],mode:'equal'});assert.deepEqual(direct.payerIds,['b']);assert.deepEqual(direct.participantIds,['a']);
});
test('defaults validate each split mode without needing a bill total',()=>{
 validateExpenseDefaults({...preset,mode:'equal',splitValues:{}});validateExpenseDefaults(preset);
 validateExpenseDefaults({...preset,mode:'shares',splitValues:{a:'2.5',b:'1'}});
 validateExpenseDefaults({...preset,mode:'exact',splitValues:{a:'30',b:'20'}});validateExpenseDefaults({...preset,mode:'exact',splitValues:{a:'30',b:'0'}});
 validateExpenseDefaults({...preset,mode:'adjustment',splitValues:{a:'-10',b:'20'}});
 for(const value of [{...preset,payerIds:[]},{...preset,participantIds:[]},{...preset,splitValues:{a:'40',b:'50'}},{...preset,mode:'shares',splitValues:{a:'-1',b:'2'}},{...preset,mode:'adjustment',splitValues:{a:'nonsense'}}]) assert.throws(()=>validateExpenseDefaults(value as ExpenseDefaults));
});
test('default contributions add up exactly with deterministic paise rounding',()=>{
 assert.deepEqual(defaultPayerAmounts('10.01',['b','a']),{a:'5.01',b:'5.00'});
 assert.deepEqual(defaultPayerAmounts('0.01',['c','b','a']),{a:'0.01',b:'0.00',c:'0.00'});
 assert.deepEqual(defaultPayerAmounts('',['a','b']),{});assert.deepEqual(defaultPayerAmounts('bad',['a','b']),{});
});
