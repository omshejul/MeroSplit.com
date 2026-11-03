import test from 'node:test';
import assert from 'node:assert/strict';
import { createSettingWriter } from '../src/settingWriter.ts';
const tick=async()=>{for(let i=0;i<10;i++)await Promise.resolve()};
function fixture(){const calls:{value:boolean,resolve:(v:boolean)=>void,reject:(e:Error)=>void}[]=[];const states:any[]=[];const writer=createSettingWriter(true,value=>new Promise<boolean>((resolve,reject)=>calls.push({value,resolve,reject})),state=>states.push(state));return{writer,calls,states}}
test('rapid switches render latest intent immediately and serialize/coalesce writes',async()=>{
 const{writer,calls}=fixture();writer.change(false);writer.change(true);assert.equal(writer.snapshot.value,true);assert.equal(calls.length,1);calls[0].resolve(false);await tick();assert.equal(writer.snapshot.value,true);assert.equal(writer.snapshot.saving,true);assert.equal(calls[1].value,true);calls[1].resolve(true);await tick();assert.deepEqual(writer.snapshot,{value:true,saving:false,error:''});
 writer.change(false);writer.change(true);writer.change(false);assert.equal(calls.length,3);calls[2].resolve(false);await tick();assert.equal(calls.length,4);assert.equal(calls[3].value,false);calls[3].resolve(false);await tick();assert.equal(writer.snapshot.value,false);
});
test('an older failure never rolls back a newer intent, latest failure restores confirmation and Retry resends its intended value',async()=>{
 const{writer,calls}=fixture();writer.change(false);writer.change(true);calls[0].reject(Error('Offline'));await tick();assert.equal(writer.snapshot.value,true);assert.equal(writer.snapshot.error,'');calls[1].resolve(true);await tick();writer.change(false);calls[2].reject(Error('Offline'));await tick();assert.equal(writer.snapshot.value,true);assert.match(writer.snapshot.error,/Could not save/);writer.retry();assert.equal(writer.snapshot.value,false);calls[3].resolve(false);await tick();assert.deepEqual(writer.snapshot,{value:false,saving:false,error:''});
});
test('background loads cannot replace unsaved intent and duplicate taps do not add writes',async()=>{
 const{writer,calls}=fixture();writer.change(false);writer.change(false);writer.hydrate(true);assert.equal(calls.length,1);assert.equal(writer.snapshot.value,false);calls[0].resolve(false);await tick();writer.hydrate(true);assert.equal(writer.snapshot.value,true);
});
