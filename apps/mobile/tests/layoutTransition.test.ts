import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
test('layout changes animate only with motion enabled and nested controls schedule one transition',()=>{
 const configs:any[]=[],tasks:(()=>void)[]=[],exports:any={};
 const source=readFileSync(new URL('../src/layoutTransition.ts',import.meta.url),'utf8');
 runInNewContext(ts.transpile(source,{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}),{exports,queueMicrotask:(fn:()=>void)=>tasks.push(fn),require:()=>({LayoutAnimation:{configureNext:(config:any)=>configs.push(config)}})});
 exports.animateLayout(false);assert.equal(configs.length,0);
 exports.animateLayout(true);exports.animateLayout(true);assert.equal(configs.length,1);
 assert.equal(configs[0].duration,180);assert.equal(configs[0].create.property,'opacity');assert.ok(configs[0].update);assert.equal(configs[0].delete.property,'opacity');
 tasks.splice(0).forEach(fn=>fn());exports.animateLayout(true);assert.equal(configs.length,2);
});
