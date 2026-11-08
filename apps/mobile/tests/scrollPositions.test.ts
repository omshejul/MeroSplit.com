import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const app=ts.createSourceFile('App.tsx',readFileSync(new URL('../App.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
function production(name:string,env:any){let body='';function visit(n:ts.Node){if(ts.isFunctionDeclaration(n)&&n.name?.text===name)body=n.getText(app);ts.forEachChild(n,visit);}visit(app);return new Function('env',`with(env){${ts.transpile(body,{target:ts.ScriptTarget.ES2022})};return ${name};}`)(env);}
test('Back from archived/removed groups smoothly restores the original list offset in the same account',()=>{
 for(const enabled of [true,false]){const moves:any[]=[],frames:(()=>void)[]=[];let archived=true,hidden=true;const env:any={screen:'home',tab:'Groups',showArchived:true,showHidden:false,homeGroupOffset:{current:{owner:'account',y:740}},owner:'account',ownerRef:{current:'account'},setShowArchived:(v:boolean)=>archived=v,setShowHidden:(v:boolean)=>hidden=v,requestAnimationFrame:(fn:()=>void)=>frames.push(fn),scroll:{current:{scrollTo:(v:any)=>moves.push(v)}},motion:{enabled}};production('back',env)();assert.equal(archived,false);assert.equal(hidden,false);frames.shift()!();assert.deepEqual(moves,[{y:740,animated:enabled}]);}
});
test('a queued list restoration cannot move the next signed-in account',()=>{
 const moves:any[]=[],frames:(()=>void)[]=[];const env:any={screen:'home',tab:'Groups',showArchived:false,showHidden:true,homeGroupOffset:{current:{owner:'a',y:400}},owner:'a',ownerRef:{current:'a'},setShowArchived(){},setShowHidden(){},requestAnimationFrame:(fn:()=>void)=>frames.push(fn),scroll:{current:{scrollTo:(v:any)=>moves.push(v)}},motion:{enabled:true}};production('back',env)();env.ownerRef.current='b';frames.shift()!();assert.deepEqual(moves,[]);
});
for(const file of ['FallbackTabLayout.tsx','HomeTabs.ios.tsx'])test(`${file} keeps previously visited tab content mounted`,()=>{
 const source=readFileSync(new URL('../src/'+file,import.meta.url),'utf8').replace(/^import .*;\n/gm,'').replace(/^export (?:default )?/gm,'');const slots:any[]=[];let cursor=0;const calls:string[]=[];
 const React={createElement:(type:any,props:any,...children:any[])=>({type,props,children})};
 const env={React,View:'View',Animated:{View:'Animated'},AppTabs:'AppTabs',SafeAreaProvider:'SafeAreaProvider',Tabs:{Host:'Host',Screen:'Screen'},Platform:{Version:27},useUI:()=>({palette:{},dark:false}),useHomeTabSwipe:()=>({content:{style:{flex:1}}}),useRef:(value:any)=>slots[cursor++]??={current:value}};
 const fn=new Function('env',`with(env){${ts.transpile(source,{jsx:ts.JsxEmit.React,target:ts.ScriptTarget.ES2022})};return ${file.startsWith('Fallback')?'FallbackTabLayout':'HomeTabs'};}`)(env);
 const render=(selected:string)=>{cursor=0;calls.length=0;return fn({selected,busy:false,onSelect(){},render:(tab:string)=>{calls.push(tab);return tab;}});};render('Groups');assert.deepEqual(calls,['Groups']);render('Activity');assert.deepEqual(new Set(calls),new Set(['Groups','Activity']));const tree=render('Groups');assert.deepEqual(new Set(calls),new Set(['Groups','Activity']));
 const nodes=(value:any):any[]=>Array.isArray(value)?value.flatMap(nodes):value&&typeof value==='object'?[value,...nodes(value.children)]:[];const hidden=nodes(tree).find(value=>value.type==='Animated'&&value.props?.['aria-hidden']);assert.ok(hidden);assert.equal(hidden.props.style.position,'absolute');assert.equal(hidden.props.style.opacity,0);assert.equal(hidden.props.pointerEvents,'none');assert.equal(hidden.props.importantForAccessibility,'no-hide-descendants');
});
