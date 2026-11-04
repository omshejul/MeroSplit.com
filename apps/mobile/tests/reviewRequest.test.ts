import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {initialReviewState,reviewEligible,reviewDay} from '../src/reviewPolicy.ts';
const flush=async()=>{for(let i=0;i<5;i++)await new Promise(resolve=>setImmediate(resolve));};
function harness(os='ios'){
 let now=7*reviewDay,slots:any[]=[],cursor=0,listener:any,requests=0,claims=0,available=true,check:any,dialogs=false,keyboard=false,focused=false;
 let props:any={owner:'one',groupId:'g',foreground:true,eligible:true};const timers=new Map<number,()=>void>(),effects=new Map<number,{deps:any[];clean?:()=>void}>(),pending:any[]=[];
 const state={...initialReviewState(0),sessions:3,settlement:true};
 const env:any={React:{createElement:(type:any,props:any,...children:any[])=>({type,props:props??{},children})},useRef:(value:any)=>{const i=cursor++;return slots[i]??=( {current:value});},useState:(value:any)=>{const i=cursor++;if(!(i in slots))slots[i]=value;return[slots[i],(v:any)=>slots[i]=typeof v==='function'?v(slots[i]):v];},useEffect:(fn:any,deps:any[])=>{const i=cursor++;const old=effects.get(i);if(!old||deps.some((v:any,n:number)=>v!==old.deps[n]))pending.push(()=>{old?.clean?.();effects.set(i,{deps,clean:fn()});});},Platform:{OS:os},AppState:{currentState:'active'},Keyboard:{isVisible:()=>keyboard},TextInput:{State:{currentlyFocusedInput:()=>focused}},hasOpenDialogs:()=>dialogs,Date:{now:()=>now},setTimeout:(fn:any)=>{const id=timers.size+1;timers.set(id,fn);return id;},clearTimeout:(id:number)=>timers.delete(id),subscribeReviewActions:(fn:any)=>{listener=fn;return()=>listener=null;},successfulReviewAction:()=> 'expense',beginReviewSession:async()=>{},updateReviewPreferences:async(fn:any)=>fn(state),claimReviewRequest:async()=>{claims++;if(!reviewEligible(state,now))return false;state.attempts.push(now);return true;},nativeReviewModule:()=>available?{isAvailableAsync:()=>check?check():Promise.resolve(true),requestReview:async()=>{requests++;}}:null,openStoreReview:async()=>{},SettingsRow:'SettingsRow',ErrorText:'ErrorText'};
 const code=ts.transpile(readFileSync(new URL('../src/ReviewRequest.tsx',import.meta.url),'utf8').replace(/^import .*$/gm,''),{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React});
 const exports:any={};new Function('env','exports',`with(env){${code}}`)(env,exports);
 const render=(next:any={})=>{props={...props,...next};cursor=0;exports.default(props);pending.splice(0).forEach(fn=>fn());};
 return{env,state,render,requests:()=>requests,claims:()=>claims,opportunity:async()=>{listener?.('one',{group_id:'g',body:{id:'e'}});await flush();render();},advance:()=>now+=35_000,run:async()=>{const work=[...timers.values()];timers.clear();work.forEach(fn=>fn());await flush();},available:(v:boolean)=>available=v,check:(fn:any)=>check=fn,dialogs:(v:boolean)=>dialogs=v,keyboard:(v:boolean)=>keyboard=v,focus:(v:boolean)=>focused=v};
}
test('native request waits for a confirmed action and quiet group, then uses native module once',async()=>{
 const h=harness();h.render();h.advance();await h.run();assert.equal(h.requests(),0);
 await h.opportunity();await h.run();assert.equal(h.requests(),1);assert.equal(h.claims(),1);
 await h.opportunity();await h.run();assert.equal(h.requests(),1);
});
test('build 32 or unavailable module never opens an automatic store link or consumes quota',async()=>{
 const h=harness();h.available(false);h.render();h.advance();await h.opportunity();await h.run();assert.equal(h.claims(),0);assert.equal(h.requests(),0);
});
test('startup, forms, background, modal and keyboard prevent review interruptions',async()=>{
 for(const block of ['startup','form','background','modal','keyboard','focus']){
  const h=harness();h.render();if(block!=='startup')h.advance();await h.opportunity();
  if(block==='form')h.render({eligible:false});if(block==='background')h.render({foreground:false});if(block==='modal')h.dialogs(true);if(block==='keyboard')h.keyboard(true);if(block==='focus')h.focus(true);
  await h.run();assert.equal(h.claims(),0,block);assert.equal(h.requests(),0,block);
 }
});
test('account or group changes while native availability is resolving cancel the old request',async()=>{
 for(const next of [{owner:'two'},{groupId:'other'},{eligible:false}]){
  const h=harness();let resolve:any;h.check(()=>new Promise(r=>resolve=r));h.render();h.advance();await h.opportunity();await h.run();h.render(next);resolve(true);await flush();assert.equal(h.requests(),0);assert.equal(h.claims(),0);
 }
});
test('website never registers automatic review opportunities',async()=>{
 const h=harness('web');h.render();h.advance();await h.opportunity();await h.run();assert.equal(h.claims(),0);assert.equal(h.requests(),0);
});

test('a new touch during the quiet pause cancels the request',async()=>{
 const h=harness(),interaction={current:0};h.render({interaction});h.advance();await h.opportunity();interaction.current++;await h.run();assert.equal(h.claims(),0);assert.equal(h.requests(),0);
});
