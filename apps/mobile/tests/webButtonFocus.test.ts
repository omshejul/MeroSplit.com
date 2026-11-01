import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
function button(extra: Record<string, any> = {}){
 const file=ts.createSourceFile('ui.tsx',readFileSync(new URL('../src/ui.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 const statement=file.statements.find(n=>ts.isVariableStatement(n)&&n.declarationList.declarations.some(d=>d.name.getText(file)==='Button'))!;
 let focused=false;const React={forwardRef:(fn:any)=>fn,createElement:(type:any,props:any,...children:any[])=>({type,props,children})};
 const render=new Function('env',`with(env){${ts.transpile(statement.getText(file).replace(/^export /,''),{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React})};return Button;}`)({React,useState:()=>[focused,(value:boolean)=>focused=value],usePressFeedback:()=>({onPressIn(){},onPressOut(){}}),useUI:()=>({palette:{accent:'accent'},ui:{},dark:false}),Platform:{OS:'web'},Pressable:'Pressable',View:'View',Text:'Text',tapHaptic(){},...extra});
 return (props: Record<string, any> = {})=>render({title:'Activity',...props},null);
}
test('mouse focus is quiet; keyboard focus stays visible and pointer use clears it',()=>{
 const render=button();let tree=render();
 tree.props.onFocus({currentTarget:{matches:()=>false}});
 assert.ok(!render().props.style({pressed:false}).some((s:any)=>s?.outlineWidth===2));
 tree.props.onFocus({currentTarget:{matches:(selector:string)=>selector===':focus-visible'}});
 assert.ok(render().props.style({pressed:false}).some((s:any)=>s?.outlineWidth===2));
 render().props.onPointerDown({});
 assert.ok(!render().props.style({pressed:false}).some((s:any)=>s?.outlineWidth===2));
});


test('shared buttons give one haptic on completed actions, never on touch-down or disabled taps', () => {
 const calls: string[] = [], emit = (value: string) => calls.push(value), render = button({ tapHaptic: () => emit('haptic') });
 const tree = render({ onPress: () => emit('action') });
 tree.props.onPressIn({}); tree.props.onPressOut({}); assert.deepEqual(calls, []);
 tree.props.onPress({}); assert.deepEqual(calls, ['haptic', 'action']);
 render({ disabled: true, onPress: () => emit('disabled') }).props.onPress({});
 render().props.onPress({}); assert.deepEqual(calls, ['haptic', 'action']);
});
