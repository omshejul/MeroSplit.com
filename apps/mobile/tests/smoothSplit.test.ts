import { withSharedUI } from './componentHarness.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as accounting from '../src/accounting.ts';
import { currencySymbol } from '../src/currency.ts';
const source=ts.createSourceFile('ExpenseForm.tsx',readFileSync(new URL('../src/ExpenseForm.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const code=source.statements.filter(n=>!ts.isImportDeclaration(n)).map(n=>n.getText(source).replace(/^export (?:default )?/, '')).join('\n');
const React={createElement:(type:any,props:any,...children:any[])=>({type,props:props??{},children})};
function fixture(){const events:string[]=[];const env:any={...accounting,currencySymbol,React,View:'View',Text:'Text',Button:'Button',Avatar:'Avatar',Icon:'Icon',TextField:'TextField',RadioChoice:'RadioChoice',Checkbox:{Item:'Checkbox'},StyleSheet:{create:(v:any)=>v,hairlineWidth:1},useUI:()=>({ui:{},palette:{},motion:{enabled:true}}),animateLayout:()=>events.push('animation'),useLayoutTransition:()=>()=>events.push('animation')};
const fields=new Function('env',`with(env){${ts.transpile(code,{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React})};return {PayerFields,SplitFields,PersonChoice};}`)(withSharedUI(env));return {...fields,events};}
const nodes=(t:any):any[]=>Array.isArray(t)?t.flatMap(nodes):t?.children?[t,...t.children.flatMap(nodes)]:[];
const draft={amount:'1200',mode:'equal',participantIds:['a','b'],payerIds:['a'],payerAmounts:{a:'1200'},splitValues:{}};
const props={participants:[{id:'a',name:'Om',profile_photo:{id:'photo-a'}},{id:'b',name:'Dev'}],draft,disabled:false,preserveRemoved:false,label:(id:string)=>id,onChange:()=>{},status:''};
test('adding a payer schedules layout motion before changing the selected people',()=>{const f=fixture();const tree=f.PayerFields({...props,onToggle:()=>f.events.push('toggle'),onAdjust:()=>{}});nodes(tree).find(n=>n.type==='Button'&&n.props.accessibilityRole==='checkbox'&&n.props.accessibilityLabel==='b').props.onPress();assert.deepEqual(f.events,['animation','toggle']);});
test('split methods are a compact icon-and-label selector before the person list',()=>{const f=fixture(),tree=f.SplitFields(props);const flat=nodes(tree);const group=flat.find(n=>n.props.accessibilityRole==='radiogroup'||n.props.role==='radiogroup');assert.ok(group,'Expected a segmented split-method selector');const choices=nodes(group).filter(n=>n.type==='Button');assert.equal(choices.length,4);for(const option of choices){assert.ok(nodes(option).some(n=>n.type==='Icon'||n.type==='Text'&&n.children.includes(currencySymbol())));assert.ok(nodes(option).some(n=>n.type==='Text'));}assert.ok(flat.indexOf(group)<flat.findIndex(n=>n.type==='Button'&&n.props.accessibilityRole==='checkbox'));});
