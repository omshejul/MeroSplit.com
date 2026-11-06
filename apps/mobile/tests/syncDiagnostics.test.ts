import test from 'node:test';
import assert from 'node:assert/strict';
import {configureSyncDiagnostics,reportSyncDiagnostic,configureRequestTracing,traceDiagnosticRequest} from '../src/syncDiagnostics.ts';
test('broken diagnostic observers cannot prevent saving',()=>{
 configureSyncDiagnostics(()=>{throw Error('SDK unavailable');});assert.doesNotThrow(()=>reportSyncDiagnostic({phase:'failed',userId:'80',pending_count:1}));configureSyncDiagnostics(()=>{});
});
test('tracing SDK errors before or after invoking a request never replay it',async()=>{
 for(const phase of ['before','after','unavailable','duplicate']){
  let calls=0;configureRequestTracing(async(_details,task)=>{if(phase==='before')throw Error('SDK');if(phase==='unavailable')return undefined as never;const result=await task();if(phase==='after')throw Error('SDK');if(phase==='duplicate')await task();return result;});
  // A missing client can return undefined synchronously, as withScope's SDK type allows.
  if(phase==='unavailable')configureRequestTracing(()=>undefined);
  const value=await traceDiagnosticRequest({userId:'80',method:'POST',route:'/expenses'},async()=>{calls++;return 'saved';});
  assert.equal(value,'saved');assert.equal(calls,1,phase);
 }
 configureRequestTracing((_details,task)=>task());
});
test('an actual request failure propagates unchanged and is never retried by tracing',async()=>{
 let calls=0;const failure=Error('network');configureRequestTracing((_details,task)=>task());await assert.rejects(traceDiagnosticRequest({userId:'80',method:'POST',route:'/expenses'},async()=>{calls++;throw failure;}),error=>error===failure);assert.equal(calls,1);
});
test('tracing preserves immediate network dispatch required by account-switch cancellation',async()=>{
 let started=false;configureRequestTracing((_details,task)=>task());const pending=traceDiagnosticRequest({userId:'80',method:'POST',route:'/expenses'},async()=>{started=true;return 'saved';});assert.equal(started,true);await pending;
});
