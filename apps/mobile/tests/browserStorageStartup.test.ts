import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { DatabaseSync } from 'node:sqlite';
import { sqliteAdapter } from './sqlite.ts';
import { migrate, saveDraft, readDraft } from '../src/storage.ts';
import { serializedDatabase } from '../src/webDatabase.ts';
import { openBrowserStorage } from '../src/browserStorage.ts';

test('browser startup uses the deployed WASM URL for persistent storage and its fallback',async()=>{
 for(const failPersistent of [false,true]){
  const raw=new DatabaseSync(':memory:'),db=sqliteAdapter(raw),configs:any[]=[],opened:string[]=[];
  const sqlite={configureWeb:(value:any)=>configs.push(value),openDatabaseAsync:async(name:string)=>{opened.push(name);if(failPersistent&&name!==':memory:')throw Error('OPFS unavailable');return db;}};
  const mocks:any={'./connectivity':{serverReachable:()=>true},'expo-sqlite':sqlite,'./storage':{migrate},'./webDatabase':{serializedDatabase},'./browserStorage':{openBrowserStorage},'./browserAuth.ts':{},'./theme':{}};
  const code=ts.transpile(readFileSync(new URL('../src/native.web.ts',import.meta.url),'utf8'),{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS});
  const module={exports:{} as any};
  try{
   new Function('require','module','exports','window','navigator',code)((name:string)=>{assert.ok(name in mocks,name);return mocks[name];},module,module.exports,{crossOriginIsolated:true},{storage:{getDirectory:()=>{}}});
   const actual=await module.exports.getDatabase();await saveDraft(actual,'test','draft',{amount:'42'});
   assert.deepEqual(await readDraft(actual,'test','draft'),{amount:'42'});
   assert.equal(await module.exports.getDatabase(),actual,'an open temporary database is never replaced underneath saved work');
   assert.equal(module.exports.storageIsDurable(),!failPersistent);
   assert.ok(configs.every(value=>value.wasmURL==='/app/sqlite.wasm'),'fallback must retain the same WASM URL');
   assert.equal(configs.at(-1).memoryOnly,failPersistent?true:undefined);
   assert.deepEqual(opened,failPersistent?['merosplit-web.db','merosplit-web.db',':memory:']:['merosplit-web.db']);
  }finally{raw.close();}
 }
});

test('temporary commands, drafts and uploads guard page unload; an untouched tab does not', () => {
 const source=ts.createSourceFile('App.tsx',readFileSync(new URL('../App.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 let callback:ts.Node|undefined;
 function visit(node:ts.Node){if(ts.isCallExpression(node)&&node.expression.getText(source)==='useEffect'&&node.arguments[0]?.getText(source).includes("addEventListener('beforeunload'"))callback=node.arguments[0];ts.forEachChild(node,visit);}visit(source);assert.ok(callback);
 for(const work of [{commands:[],hasDrafts:false,pendingFiles:0},{commands:[{}],hasDrafts:false,pendingFiles:0},{commands:[],hasDrafts:true,pendingFiles:0},{commands:[],hasDrafts:false,pendingFiles:1}]){
  let listener:((event:any)=>void)|undefined,removed=false;
  const env={...work,Platform:{OS:'web'},storageIsDurable:()=>false,window:{addEventListener:(_name:string,fn:any)=>listener=fn,removeEventListener:()=>{removed=true;}}};
  // Evaluate the actual production effect rather than copying its guard.
  const run=new Function('env',`with(env){${ts.transpile(`const effect=${callback.getText(source)};`,{target:ts.ScriptTarget.ES2022})};return effect();}`);
  const cleanup=run(env),hasWork=!!(work.commands.length||work.hasDrafts||work.pendingFiles);
  assert.equal(!!listener,hasWork);
  if(listener){let prevented=false;listener({preventDefault(){prevented=true;},returnValue:undefined});assert.equal(prevented,true);cleanup();assert.equal(removed,true);}
 }
});
