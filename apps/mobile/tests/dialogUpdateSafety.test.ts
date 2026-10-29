import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

test('visible modal focus scopes block update restart until every modal closes',()=>{
 const source=ts.createSourceFile('DialogFocus.tsx',readFileSync(new URL('../src/DialogFocus.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 const body=source.statements.filter(node=>!ts.isImportDeclaration(node)).map(node=>node.getText(source).replace(/^export (default )?/, '')).join('\n');
 let cleanup:(()=>void)|undefined;
 const env={React:{createElement:(type:any,props:any,...children:any[])=>({type,props,children})},View:'View',Platform:{OS:'native'},useRef:()=>({current:null}),useDialogMotion(){},useEffect(){},useLayoutEffect(effect:()=>void|(()=>void)){cleanup=effect()||undefined;}};
 const {DialogFocus,hasOpenDialogs}=new Function('env',`with(env){${ts.transpile(body,{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React})};return {DialogFocus,hasOpenDialogs};}`)(env);
 function mount(props:any): (()=>void)|undefined {cleanup=undefined;DialogFocus({children:null,...props});return cleanup;}
 assert.equal(hasOpenDialogs(),false);mount({active:false});assert.equal(hasOpenDialogs(),false);mount({modal:false});assert.equal(hasOpenDialogs(),false,'full-screen join focus scope is not a modal');
 const first=mount({active:true}),second=mount({active:true});assert.equal(hasOpenDialogs(),true);first!();assert.equal(hasOpenDialogs(),true);second!();assert.equal(hasOpenDialogs(),false);
});
