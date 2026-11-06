import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const file=ts.createSourceFile('App.tsx',readFileSync(new URL('../App.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const hold=file.statements.find(node=>ts.isIfStatement(node)&&node.getText(file).includes('SplashScreen.preventAutoHideAsync'))!;
let release='';function visit(node:ts.Node){if(ts.isCallExpression(node)&&node.expression.getText(file)==='useEffect'&&node.arguments[0]?.getText(file).includes('SplashScreen.hideAsync'))release=node.getText(file);ts.forEachChild(node,visit);}visit(file);
function start(os:string,ready:boolean){
 const state={held:0,hidden:0,cancelled:[] as number[],frames:[] as (()=>void)[],cleanup:undefined as undefined|(()=>void)};
 const env={Platform:{OS:os},ready,SplashScreen:{preventAutoHideAsync:()=>{state.held++;return Promise.resolve();},hideAsync:()=>{state.hidden++;return Promise.resolve();}},useEffect:(fn:()=>any)=>state.cleanup=fn(),requestAnimationFrame:(fn:()=>void)=>{state.frames.push(fn);return state.frames.length;},cancelAnimationFrame:(id:number)=>state.cancelled.push(id)};
 new Function('env',`with(env){${ts.transpile(hold.getText(file),{target:ts.ScriptTarget.ES2022})};${release};}`)(env);
 return state;
}
test('native launch screen stays until local restoration is ready and the next frame can paint',()=>{
 const waiting=start('ios',false);assert.equal(waiting.held,1);assert.equal(waiting.hidden,0);assert.equal(waiting.frames.length,0);
 for(const os of ['ios','android']){const ready=start(os,true);assert.equal(ready.hidden,0);assert.equal(ready.frames.length,1);ready.frames[0]();assert.equal(ready.hidden,1);ready.cleanup?.();assert.deepEqual(ready.cancelled,[1]);}
});
test('web startup does not hold or hide a native launch screen',()=>{const web=start('web',true);assert.equal(web.held,0);assert.equal(web.hidden,0);assert.equal(web.frames.length,0);});
