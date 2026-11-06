import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const source=ts.createSourceFile('ChatLoadingState.tsx',readFileSync(new URL('../src/ChatLoadingState.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),body=source.statements.filter(n=>!ts.isImportDeclaration(n)).map(n=>n.getText(source).replace(/^export (?:default )?/,'')).join('\n');
function fixture(enabled:boolean,os:string){let cleanup:any;const events:any[]=[];class Value{value:number;constructor(v:number){this.value=v}setValue(v:number){this.value=v}}
 const env={React:{createElement:(type:any,props:any,...children:any[])=>({type,props,children})},Text:'Text',View:'View',Platform:{OS:os},useRef:(v:any)=>({current:v}),useEffect:(fn:any)=>{cleanup=fn()},useUI:()=>({palette:{soft:'#ddd'},ui:{caption:{}},motion:{enabled}}),Animated:{Value,View:'AnimatedView',timing:(_v:any,options:any)=>{events.push(options);return options},sequence:(steps:any)=>steps,loop:()=>({start:()=>events.push('start'),stop:()=>events.push('stop')})}};
 const render=new Function('env',`with(env){${ts.transpile(body,{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React})};return ChatLoadingState;}`)(env);return{tree:render(),events,unmount:()=>cleanup?.()}}
test('chat placeholders pulse without delaying interactions and stop on unmount',()=>{for(const os of ['ios','android','web']){const a=fixture(true,os);assert.equal(a.tree.props.accessibilityLabel,'Loading messages');assert.equal(a.tree.props.pointerEvents,'none');assert.equal(a.events[0].isInteraction,false);assert.equal(a.events[0].useNativeDriver,os!=='web');assert.ok(a.events.includes('start'));a.unmount();assert.ok(a.events.includes('stop'))}});
test('reduced motion renders static placeholders without starting a pulse',()=>{const a=fixture(false,'ios');assert.deepEqual(a.events,[]);assert.equal(a.tree.children[1].props.style.opacity.value,1)});
