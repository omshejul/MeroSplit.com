import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';
import { categoryIcon, expenseCategory, expenseIconChoices } from '../src/categoryIcons.ts';
import { previewPending } from '../src/ledger.ts';
import { expensePayload } from '../src/api.ts';
import { migrate, saveGroup, enqueueBill, pendingCommands, readVisibleGroup } from '../src/storage.ts';
import { sqliteAdapter } from './sqlite.ts';
import type { Command, Expense, Group } from '../src/types.ts';

type Element = { type: string; props: Record<string, any>; children: any[] };
function picker(props: Record<string, any>) {
 const source=readFileSync(new URL('../src/BillIconPicker.tsx',import.meta.url),'utf8').replace(/^import .*;\n/gm,'').replace('export default function','function');
 const slots:any[]=[];let cursor=0;
 const React={createElement:(type:string,props:any,...children:any[]):Element=>({type,props:props??{},children})};
 const env={React,View:'View',FlatList:'FlatList',Modal:'Modal',Pressable:'Pressable',Icon:'Icon',Button:'Button',ErrorText:'ErrorText',DialogFocus:'DialogFocus',StyleSheet:{absoluteFill:{}},requestAnimationFrame:(call:()=>void)=>call(),categoryIcon,expenseIconChoices,useWindowDimensions:()=>({width:393,height:852}),useSafeAreaInsets:()=>({top:44,bottom:34}),useUI:()=>({palette:{text:'white',muted:'gray',accent:'purple',soft:'soft',surface:'surface',outline:'line'},motion:{enabled:false}}),useEffect(){},useState(initial:any){const index=cursor++;if(!(index in slots))slots[index]=initial;return [slots[index],(value:any)=>{slots[index]=typeof value==='function'?value(slots[index]):value;}];},useRef(initial:any){const index=cursor++;if(!(index in slots))slots[index]={current:initial};return slots[index];}};
 const component=new Function('env',`with(env){${ts.transpile(source,{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React})};return BillIconPicker;}`)(env);
 return ()=>{cursor=0;return component(props);};
}
function nodes(tree:any):Element[]{return Array.isArray(tree)?tree.flatMap(nodes):tree&&typeof tree==='object'?[tree,...nodes(tree.children)]:[];}
const find=(tree:any,type:string)=>nodes(tree).find(node=>node.type===type)!;
const settle=()=>new Promise(resolve=>setImmediate(resolve));

test('picker has all 75 options, icon-only radio cells, and waits for durable acceptance before closing',async()=>{
 let queued:()=>void=()=>{},release:()=>void=()=>{},calls=0;
 const render=picker({category:'wastecollection',onSelect:async(category:string,onQueued:()=>void)=>{assert.equal(category,'food');calls++;queued=onQueued;await new Promise<void>(resolve=>{release=resolve;});}});
 let tree=render();find(tree,'Button').props.onPress();tree=render();
 const grid=find(tree,'FlatList');assert.equal(grid.props.numColumns,5);assert.equal(grid.props.data.length,75);
 const all=grid.props.data.map((item:any)=>grid.props.renderItem({item}));assert.ok(all.every((item:any)=>item.props.accessibilityLabel&&item.props.accessibilityRole==='radio'&&item.children[0].type==='Icon'));
 const food=all.find((item:any)=>item.props.accessibilityLabel==='Food');assert.ok(food);
 food.props.onPress();food.props.onPress();assert.equal(calls,1);assert.ok(find(render(),'Modal'),'sheet stays open before durable enqueue');
 assert.ok(find(render(),'FlatList').props.renderItem({item:expenseIconChoices[0]}).props.disabled);
 queued();assert.equal(find(render(),'Modal'),undefined);release();await settle();
 assert.equal(find(render(),'Icon').props.name,'food');
});

test('failed local save keeps the sheet open, shows an error, and permits a retry',async()=>{
 const render=picker({category:'general',onSelect:async()=>{throw new Error('Disk is full');}});
 find(render(),'Button').props.onPress();const grid=find(render(),'FlatList');grid.props.renderItem({item:expenseIconChoices[1]}).props.onPress();await settle();
 const tree=render();assert.ok(find(tree,'Modal'));assert.deepEqual(find(tree,'ErrorText').children,['Disk is full']);assert.equal(find(tree,'FlatList').props.renderItem({item:expenseIconChoices[1]}).props.disabled,false);
});

test('reversed and readonly bills cannot open a picker',()=>{
 const readonly=picker({category:'food'});assert.equal(find(readonly(),'Button'),undefined);
 const reversed=picker({category:'food',reversed:true,onSelect:async()=>{}});assert.equal(find(reversed(),'Button'),undefined);assert.equal(find(reversed(),'Icon').props.name,'refresh');
 const disabled=picker({category:'food',disabled:true,onSelect:async()=>{}});assert.equal(find(disabled(),'Button').props.disabled,true);
});

function saveIcon(env:Record<string,any>){
 const source=ts.createSourceFile('App.tsx',readFileSync(new URL('../App.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let found:ts.FunctionDeclaration|undefined;
 function visit(node:ts.Node){if(ts.isFunctionDeclaration(node)&&node.name?.text==='changeExpenseIcon')found=node;ts.forEachChild(node,visit);}visit(source);assert.ok(found);
 return new Function('env',`with(env){${ts.transpile(found.getText(source),{target:ts.ScriptTarget.ES2022})};return changeExpenseIcon;}`)(env);
}

test('manual icon survives a real SQLite restart and changes no financial fields',async()=>{
 const folder=mkdtempSync(join(homedir(),'.codex/tmp/bill-icon-test-')),path=join(folder,'data.sqlite');let raw=new DatabaseSync(path),db=sqliteAdapter(raw);
 const expense:Expense={id:'bill',version:1,description:'Lunch',total:'30000',paid:{a:'30000'},shares:{a:'10000',b:'10000',c:'10000'},split:{mode:'equal',values:{a:'1',b:'1',c:'1'}},date:'2026-10-19',category:'general',category_auto:true,notes:'Original note',deleted:false};
 const group:Group={id:'g',name:'Trip',owner_id:1,version:1,participants:[{id:'a',name:'A'},{id:'b',name:'B'},{id:'c',name:'C'}],expenses:[expense],settlements:[],activity:[],balances:{a:'20000',b:'-10000',c:'-10000'},transfers:[]};
 try{
  await migrate(db);await saveGroup(db,'owner',group,'shared');let accepted=false;
  const save=saveIcon({selected:{group},draftWrites:{current:Promise.resolve()},groupId:'g',expenseIconChoices,expensePayload,perform:async(action:()=>Promise<void>)=>action(),command:(method:Command['method'],path:string,body:any)=>({command_id:'icon-edit',group_id:'g',base_version:1,method,path,body,state:'pending',error:null}),queue:async(value:Command,_a:any,_b:any,onQueued:()=>void)=>{await enqueueBill(db,'owner',value);onQueued();}});
  await save(expense,'cycling',()=>{accepted=true;});assert.ok(accepted);
  raw.close();raw=new DatabaseSync(path);db=sqliteAdapter(raw);await migrate(db);
  const commands=await pendingCommands(db,'owner');assert.equal(commands.length,1);assert.deepEqual(commands[0].body,{...expensePayload(expense,true),category:'cycling',category_auto:false});
  assert.equal((await pendingCommands(db,'another-account')).length,0);
  const saved=await readVisibleGroup(db,'owner','g');assert.ok(saved);const projected=previewPending(saved.group,commands),updated=projected.expenses[0];assert.equal(updated.category,'cycling');assert.equal(updated.category_auto,false);assert.deepEqual(projected.balances,group.balances);
  assert.equal(expenseCategory({...updated,groupId:'g',title:'Lunch'},{[JSON.stringify(['g','bill','Lunch'])]:'food'}),'cycling');
 }finally{raw.close();rmSync(folder,{recursive:true,force:true});}
});

test('icon saves reject unavailable, archived and reversed choices and skip an unchanged manual icon',async()=>{
 const expense={id:'bill',category:'food',category_auto:false,deleted:false};let writes=0,accepted=0;
 const env:any={selected:{group:{archived:false}},expenseIconChoices,perform:async(action:()=>Promise<void>)=>action(),draftWrites:{current:Promise.resolve()},queue:async()=>{writes++;},command(){},expensePayload};
 const save=saveIcon(env);
 await save(expense,'food',()=>{accepted++;});assert.equal(accepted,1);assert.equal(writes,0);
 await assert.rejects(save(expense,'not-an-icon',()=>{}),/available icon/);
 env.selected.group.archived=true;await assert.rejects(save(expense,'general',()=>{}),/cannot be changed/);
 env.selected.group.archived=false;await assert.rejects(save({...expense,deleted:true},'general',()=>{}),/cannot be changed/);assert.equal(writes,0);
});
