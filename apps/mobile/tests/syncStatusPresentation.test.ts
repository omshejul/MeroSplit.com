import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { syncStatus } from '../src/syncState.ts';
const source=readFileSync(new URL('../src/SyncStatus.tsx',import.meta.url),'utf8');
const code=ts.transpile(source.replace(/^import .*$/mg,''),{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React});
function render(changes:Record<string,unknown>={},all=false){
 const React={createElement:(type:unknown,props:any,...children:any[])=>({type,props:props??{},children})};
 const env={React,syncStatus,useState:()=>[true,()=>{}],useUI:()=>({ui:{},palette:{}}),Menu:'Menu',DialogFocus:'DialogFocus',Pressable:'Pressable',ActivityIndicator:'ActivityIndicator',Icon:'Icon',Text:'Text',Button:'Button'};
 const module={exports:{} as any};
 new Function('env','module','exports',`with(env){${code}}`)(env,module,module.exports);
 const tree=module.exports.default({commands:[],pendingFiles:0,drafts:false,confirmedAt:null,durable:false,syncing:false,problem:true,online:true,onPress(){},...changes});
 const nodes=(n:any):any[]=>Array.isArray(n)?n.flatMap(nodes):n&&typeof n==='object'?[n,...nodes(n.children)]:[];
 return all?nodes(tree):nodes(tree).filter(n=>n.type==='Button');
}
test('read-only offline-copy states have no saved-change action',()=>{
 assert.deepEqual(render().map(n=>n.props.title),[]);
 assert.deepEqual(render({reviewRequired:true}).map(n=>n.props.title),[]);
});
test('actual queued changes open their list; file and draft actions do their named work',()=>{
 let opened=0,retried=0,exported=0;
 const buttons=render({commands:[{state:'pending'}],onPress:()=>opened++});
 assert.deepEqual(buttons.map(n=>n.props.title),['View saved changes']);buttons[0].props.onPress();assert.equal(opened,1);
 const file=render({pendingFiles:1,onRetry:()=>retried++});assert.equal(file[0].props.title,'Retry uploads');file[0].props.onPress();assert.equal(retried,1);
 const draft=render({drafts:true,onExport:()=>exported++});assert.equal(draft[0].props.title,'Export saved work');draft[0].props.onPress();assert.equal(exported,1);
});


test('routine background sync has no visible progress while actionable errors remain available',()=>{
 assert.deepEqual(render({syncing:true},true),[]);
 assert.deepEqual(render({confirmedAt:'2026-10-28T00:00:00Z',durable:true,problem:false},true),[]);
 assert.ok(render({commands:[{state:'conflict'}],syncing:true},true).some(n=>n.type==='Menu'));
 assert.ok(!render({commands:[{state:'conflict'}],syncing:true},true).some(n=>n.type==='ActivityIndicator'));
});
