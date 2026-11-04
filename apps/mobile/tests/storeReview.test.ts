import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {initialReviewState,readReviewState,reviewEligible,reviewDay,successfulReviewAction,notifyReviewAction,subscribeReviewActions} from '../src/reviewPolicy.ts';
const eligible = () => ({...initialReviewState(0), sessions:3, settlement:true});
const action = (path='/groups/g/expenses',method='POST',id='one'):any => ({group_id:'g',path,method,body:{id},command_id:id});
test('review requires seven days, three sessions and five expenses or a recorded settlement',()=>{
 const state=initialReviewState(0),now=7*reviewDay;
 assert.equal(reviewEligible(state,now),false);
 state.sessions=3;state.expenses=['a','b','c','d'];assert.equal(reviewEligible(state,now),false);
 state.expenses.push('e');assert.equal(reviewEligible(state,now-1),false);assert.equal(reviewEligible(state,now),true);
 state.expenses=[];state.settlement=true;assert.equal(reviewEligible(state,now),true);
 state.sessions=2;assert.equal(reviewEligible(state,now),false);
});
test('review requests respect 90 days, two attempts per rolling year and clock rollback',()=>{
 const state=eligible();state.attempts=[10*reviewDay];
 assert.equal(reviewEligible(state,99*reviewDay),false);assert.equal(reviewEligible(state,100*reviewDay),true);
 state.attempts=[10*reviewDay,100*reviewDay];assert.equal(reviewEligible(state,200*reviewDay),false);
 assert.equal(reviewEligible(state,375*reviewDay),true);assert.equal(reviewEligible(state,0),false);
});
test('damaged preferences restart the waiting period without showing a prompt',()=>{
 for(const value of [null,'broken','{}',JSON.stringify({...eligible(),attempts:[null]}),JSON.stringify({...eligible(),expenses:[3]})]){
  const state=readReviewState(value,123);assert.equal(state.firstSeen,123);assert.equal(reviewEligible(state,123),false);
 }
 assert.deepEqual(readReviewState(JSON.stringify(eligible()),123),eligible());
});
test('only new confirmed expenses and settlements publish review opportunities',()=>{
 const events:any[]=[];const off=subscribeReviewActions((owner,command)=>events.push([owner,command.body.id]));
 const broken=subscribeReviewActions(()=>{throw Error('review observer failure');});
 notifyReviewAction('self',action());notifyReviewAction('self',action('/groups/g/settlements','POST','payment'));
 for(const value of [action('/groups/g/expenses/id','PUT'),action('/groups/g/expenses/id/reverse'),action('/groups/g/payment-attempts'),{...action(),body:{id:'deleted',deleted:true}}]){assert.equal(successfulReviewAction(value),null);notifyReviewAction('self',value);}
 assert.deepEqual(events,[['self','one'],['self','payment']]);off();broken();notifyReviewAction('self',action());assert.equal(events.length,2);
});
function storage(){
 let disk:string|null=null,now=0,fail=false;
 const code=ts.transpile(readFileSync(new URL('../src/reviewPreferences.ts',import.meta.url),'utf8').replace(/^import .*$/gm,''),{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS});
 const exports:any={};new Function('exports','SecureStore','readReviewState','reviewEligible','reviewDay','Date',code)(exports,{getItemAsync:async()=>disk,setItemAsync:async(_:string,v:string)=>{if(fail)throw Error('disk');disk=v;}},readReviewState,reviewEligible,reviewDay,{now:()=>now});
 return{api:exports,state:()=>JSON.parse(disk!),clock:(value:number)=>now=value,fail:(value:boolean)=>fail=value};
}
test('sessions need 30 minutes apart and preference storage survives restarts',async()=>{
 const h=storage();await h.api.beginReviewSession();await h.api.beginReviewSession();assert.equal(h.state().sessions,1);
 h.clock(30*60_000);await h.api.beginReviewSession();assert.equal(h.state().sessions,2);
 h.clock(60*60_000);await h.api.beginReviewSession();assert.equal(h.state().sessions,3);
});
test('parallel native requests claim once, storage failures prevent prompting, queue recovers',async()=>{
 const h=storage();await h.api.updateReviewPreferences((state:any)=>Object.assign(state,eligible()));h.clock(7*reviewDay);
 assert.deepEqual(await Promise.all([h.api.claimReviewRequest(),h.api.claimReviewRequest()]),[true,false]);
 h.clock(100*reviewDay);h.fail(true);await assert.rejects(h.api.claimReviewRequest(),/disk/);
 h.fail(false);assert.equal(await h.api.claimReviewRequest(),true);assert.equal(h.state().attempts.length,2);
});
test('manual store action works at any time and suppresses the next automatic request',async()=>{
 const h=storage();assert.equal(await h.api.claimReviewRequest(),false);assert.equal(await h.api.claimReviewRequest(true),true);
 await h.api.updateReviewPreferences((state:any)=>{state.sessions=3;state.settlement=true;});h.clock(7*reviewDay);assert.equal(await h.api.claimReviewRequest(),false);
});
function platform(os:string,fail=false){
 const calls:string[]=[];let native:any=null;
 const code=ts.transpile(readFileSync(new URL('../src/storeReviewPlatform.ts',import.meta.url),'utf8').replace(/^import .*$/gm,''),{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS});
 const exports:any={};new Function('env','exports',`with(env){${code}}`)({Platform:{OS:os},Linking:{openURL:async(url:string)=>{calls.push(url);if(fail&&calls.length===1)throw Error('store absent');}},requireOptionalNativeModule:()=>native,appStores:{ios:{native:'itms-apps://itunes.apple.com/app/id6823916128',web:'https://apps.apple.com/app/merosplit/id6823916128'},android:{native:'market://details?id=com.omshejul.splitdumb',web:'https://play.google.com/store/apps/details?id=com.omshejul.splitdumb'}}},exports);
 return {api:exports,calls,native:(value:any)=>native=value};
}
test('manual iOS and Android review links use fixed destinations and HTTPS fallback',async()=>{
 for(const os of ['ios','android']){
  const h=platform(os,true);await h.api.openStoreReview();assert.equal(h.calls.length,2);
  assert.match(h.calls[0],os==='ios'?/^itms-apps:\/\/.*\?action=write-review$/:/^market:\/\/.*&showAllReviews=true$/);
  assert.match(h.calls[1],os==='ios'?/^https:\/\/apps.apple.com\/.*\?action=write-review$/:/^https:\/\/play.google.com\/.*&showAllReviews=true$/);
 }
});
test('missing optional native module is safe, while web never opens a store',async()=>{
 const h=platform('ios');assert.equal(h.api.nativeReviewModule(),null);const native={requestReview:async()=>{}};h.native(native);assert.equal(h.api.nativeReviewModule(),native);
 const web=platform('web');web.native(native);assert.equal(web.api.nativeReviewModule(),null);await web.api.openStoreReview();assert.deepEqual(web.calls,[]);
});
