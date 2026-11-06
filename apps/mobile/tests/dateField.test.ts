import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

function harness(name='DateDialog', os='ios') {
 const state:any[]=[];let index=0;const saved:any[]=[];let dismissed=0;
 class Clock extends Date { constructor(value?:any){super(value ?? '2026-11-01T14:09:00');} }
 const React={createElement:(type:any,props:any,...children:any[])=>({type,props:props??{},children}),useState:(value:any)=>{const id=index++;if(!(id in state))state[id]=typeof value==='function'?value():value;return[state[id],(next:any)=>{state[id]=typeof next==='function'?next(state[id]):next;}];}};
 const modules:any={react:{__esModule:true,default:React,...React},'react-native':{Platform:{OS:os},Switch:'Switch',View:'View'},'react-native-paper':{Text:'Text'},'@react-native-community/datetimepicker':{__esModule:true,default:'Picker'},'./KeyboardDialog':{__esModule:true,default:'Dialog'},'./DialogParts':{Dialog:{Title:'Title'},DialogScrollBody:'Body',CancelDialogActions:'Actions'},'./ui':{Button:'Button',useUI:()=>({palette:{},dark:false,ui:{input:{}}})}};
 const code=ts.transpile(readFileSync(new URL('../src/DateField.tsx',import.meta.url),'utf8'),{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React,target:ts.ScriptTarget.ES2022});const exports:any={};new Function('require','exports','Date',code)((key:string)=>{assert.ok(modules[key],key);return modules[key];},exports,Clock);
 const props={label:'Date',value:'2026-10-20',onChange:(...values:any[])=>saved.push(values),onDismiss:()=>dismissed++};
 return{saved,render:(extra:any={})=>{index=0;return (name==='DateDialog'?exports.DateDialog:exports.default)({...props,...extra});},dismissed:()=>dismissed};
}
function nodes(node:any):any[]{return !node||typeof node!=='object'?[]:[node,...(node.children??[]).flat(Infinity).flatMap(nodes)];}
const find=(tree:any,match:(node:any)=>boolean)=>{const node=nodes(tree).find(match);assert.ok(node);return node;};
const button=(tree:any,title:string)=>find(tree,n=>n.type==='Button'&&n.props.title===title);

test('date field opens a separate dialog instead of expanding an inline picker',()=>{
 const app=harness('DateField');let tree=app.render();assert.ok(!nodes(tree).some(n=>n.type==='Picker'));find(tree,n=>n.type==='Button').props.onPress();tree=app.render();assert.ok(nodes(tree).some(n=>typeof n.type==='function'&&n.type.name==='DateDialog'));assert.deepEqual(app.saved,[]);
});
test('optional time defaults to current local time and saves with the chosen date',()=>{
 const app=harness();let tree=app.render();assert.equal(tree.type,'Dialog');assert.equal(find(tree,n=>n.type==='Switch').props.value,false);
 find(tree,n=>n.type==='Switch').props.onValueChange(true);tree=app.render();assert.equal(find(tree,n=>n.props.accessibilityLabel==='Choose time').props.title.includes('2:09')||find(tree,n=>n.props.accessibilityLabel==='Choose time').props.title.includes('14:09'),true);
 find(tree,n=>n.type==='Picker').props.onChange({type:'set'},new Date(2026,9,25,19,30));tree=app.render();assert.deepEqual(app.saved,[]);
 button(tree,'Save').props.onPress();assert.deepEqual(app.saved,[['2026-10-25','14:09']]);assert.equal(app.dismissed(),1);
});
test('saved time can be edited, removed, or cancelled without changing the bill',()=>{
 const app=harness();let tree=app.render({time:'08:30'});find(tree,n=>n.props.accessibilityLabel==='Choose time').props.onPress();tree=app.render({time:'08:30'});find(tree,n=>n.type==='Picker').props.onChange({type:'set'},new Date(2026,9,25,22,45));tree=app.render({time:'08:30'});button(tree,'Save').props.onPress();assert.deepEqual(app.saved,[['2026-10-20','22:45']]);
 const cancel=harness();tree=cancel.render({time:'08:30'});find(tree,n=>n.type==='Switch').props.onValueChange(false);tree=cancel.render({time:'08:30'});find(tree,n=>n.type==='Actions').props.onCancel();assert.deepEqual(cancel.saved,[]);
 button(tree,'Save').props.onPress();assert.deepEqual(cancel.saved,[['2026-10-20',null]]);
});
test('Android picker dismissal leaves draft unchanged and time remains optional',()=>{
 const app=harness('DateDialog','android');let tree=app.render();assert.ok(!nodes(tree).some(n=>n.type==='Picker'));find(tree,n=>n.props.accessibilityLabel==='Choose date').props.onPress();tree=app.render();find(tree,n=>n.type==='Picker').props.onChange({type:'dismissed'},undefined);tree=app.render();assert.ok(!nodes(tree).some(n=>n.type==='Picker'));button(tree,'Save').props.onPress();assert.deepEqual(app.saved,[['2026-10-20',null]]);
});
test('web date and time inputs stay inside the dialog and apply together',()=>{
 const app=harness('DateDialog','web');let tree=app.render({time:'08:30'});find(tree,n=>n.type==='input'&&n.props.type==='date').props.onChange({target:{value:'2026-11-02'}});tree=app.render({time:'08:30'});find(tree,n=>n.type==='input'&&n.props.type==='time').props.onChange({target:{value:'17:15'}});tree=app.render({time:'08:30'});button(tree,'Save').props.onPress();assert.deepEqual(app.saved,[['2026-11-02','17:15']]);
});
