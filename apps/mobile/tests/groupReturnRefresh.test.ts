import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const source=ts.createSourceFile('GroupScreen.tsx',readFileSync(new URL('../src/GroupScreen.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
let effect:ts.ArrowFunction;
function visit(n:ts.Node){if(ts.isCallExpression(n)&&n.expression.getText(source)==='useLayoutEffect'&&n.arguments[0]?.getText(source).includes('ownSave'))effect=n.arguments[0] as ts.ArrowFunction;ts.forEachChild(n,visit)}visit(source);
test('returning from a notification-opened bill adopts the fetched group without a second request',()=>{
 const previous={version:1,expenses:[]},fresh={version:2,expenses:[{id:'new-bill'}]};let shown:any=previous;
 const env:any={active:false,wasActive:{current:false},revision:0,adoptedRevision:{current:0},pending:[],savedCommands:{current:new Map()},commandBodies:new Map(),incoming:fresh,group:previous,incomingAccepted:fresh,incomingPreviewError:'',previewError:'',list:{current:{scrollToOffset(){}}},opacity:{stopAnimation(){},setValue(){}},motion:{enabled:false},setShown:(value:any)=>shown=value.group};
 const run=new Function('env',`with(env){ const useLoading = env.useLoading ?? (() => {}), LoadingOverlay = env.LoadingOverlay ?? 'LoadingOverlay';${ts.transpile(`const effect = ${effect!.getText(source)};`,{target:ts.ScriptTarget.ES2022})};return effect;}`)(env);
 run();assert.equal(shown,previous,'keep the current reading position while hidden');
 env.active=true;run();assert.equal(shown,fresh,'the list must show the bill as soon as it regains focus');
});
