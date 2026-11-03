import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { parseNotes, markdownText, noteLink } from '../src/markdown.ts';

type Node = {type: string; props: Record<string, any>; children: any[]};
const nodes = (value: any): Node[] => Array.isArray(value) ? value.flatMap(nodes) : value?.children ? [value,...value.children.flatMap(nodes)] : [];
const text = (value: any): string => Array.isArray(value) ? value.map(text).join('') : value?.children ? text(value.children) : typeof value === 'string' || typeof value === 'number' ? String(value) : '';
function component(file: string, name: string, extra: Record<string, any> = {}) {
 let index=0;const states:any[]=[];
 const env = {React:{createElement:(type:any,props:any,...children:any[])=>({type,props:props??{},children})},View:'View',Text:'Text',ScrollView:'ScrollView',Button:'Button',TextField:'TextField',ErrorText:'ErrorText',MarkdownNotes:'MarkdownNotes',KeyboardDialog:'KeyboardDialog',Dialog:{Title:'Title'},DialogScrollBody:'DialogScrollBody',CloseDialogActions:'CloseDialogActions',Platform:{OS:'android'},useWindowDimensions:()=>({fontScale:1.3}),useUI:()=>({ui:{body:{},caption:{},label:{}},palette:{}}),useState:(v:any)=>{const i=index++;if(!(i in states))states[i]=v;return[states[i],(next:any)=>states[i]=typeof next==='function'?next(states[i]):next]},useMemo:(fn:any)=>fn(),useRef:()=>({current:null}),Keyboard:{dismiss:()=>{}},parseNotes,markdownText,noteLink,Linking:{openURL:async()=>{}},...extra};
 const source=ts.createSourceFile(file,readFileSync(new URL('../src/'+file,import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 const body=source.statements.filter(n=>!ts.isImportDeclaration(n)&&!ts.isExportDeclaration(n)).map(n=>n.getText(source).replace(/^export (?:default )?/,'')).join('\n');
 const render=new Function('env',`with(env){${ts.transpile(body,{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React})};return ${name};}`)(env);
 return (props:any)=>{index=0;return render(props)};
}

test('GFM parser handles tables, alignment, escaped pipes, tasks, nesting, code and malformed tables',()=>{
 const table=parseNotes('| Item | Amount |\n| :--- | ---: |\n| a\\|b | **₹500** |')[0] as any;
 assert.equal(table.type,'table');assert.deepEqual(table.align,['left','right']);assert.equal(table.rows[0][0].text,'a|b');assert.equal(table.rows[0][1].tokens[0].type,'strong');
 assert.equal(parseNotes('| a | b |\nnot a delimiter')[0].type,'paragraph');
 const list=parseNotes('- [x] Paid\n- [ ] Pending\n  - Nested')[0] as any;
 assert.equal(list.items[0].checked,true);assert.equal(list.items[1].checked,false);assert.ok(list.items[1].tokens.some((t:any)=>t.type==='list'));
 assert.equal(parseNotes('```js\nconst x = 1;\n```')[0].type,'code');
});

test('notes renderer keeps content native, blocks unsafe links and remote images, and preserves literal HTML/code',async()=>{
 const opened:string[]=[];const render=component('MarkdownNotes.tsx','MarkdownNotes',{Linking:{openURL:async(href:string)=>opened.push(href)}});
 const tree=render({source:'# Dinner\n\n**Bold** and *italic* and ~~gone~~ &amp; &#38;amp; `&amp;`\n\n[Safe](https://example.com) [Unsafe](javascript:alert%281%29) ![Receipt](https://tracking.invalid/photo.jpg)\n\n<script>alert(1)</script>\n\n- [x] Done\n- [ ] Next'});
 assert.ok(nodes(tree).some(n=>n.props.accessibilityRole==='header'));assert.ok(nodes(tree).some(n=>n.props.style?.fontWeight==='600'));assert.ok(nodes(tree).some(n=>n.props.style?.fontStyle==='italic'));assert.ok(nodes(tree).some(n=>n.props.style?.textDecorationLine==='line-through'));
 const all=text(tree);assert.ok(all.includes('& &amp; &amp;'));assert.ok(all.includes('<script>alert(1)</script>'));assert.ok(all.includes('Receipt'));assert.equal(nodes(tree).filter(n=>n.type==='Image').length,0);assert.equal(nodes(tree).filter(n=>n.props.accessibilityRole==='link').length,1);
 await nodes(tree).find(n=>n.props.accessibilityRole==='link')!.props.onPress();assert.deepEqual(opened,['https://example.com']);
 assert.equal((all.match(/☑/g)||[]).length,1);assert.equal((all.match(/☐/g)||[]).length,1);assert.ok(!all.includes('[x]'));
});

test('notes table renders semantic headers, column alignment and horizontal scroll; link errors give feedback',async()=>{
 const render=component('MarkdownNotes.tsx','MarkdownNotes',{Linking:{openURL:async()=>{throw Error('offline')}}});
 let tree=render({source:'| Item | Amount |\n| --- | ---: |\n| Dinner | ₹500 |\n\n[Open](https://example.com)'});
 assert.ok(nodes(tree).some(n=>n.type==='ScrollView'&&n.props.horizontal));assert.equal(nodes(tree).filter(n=>n.props.role==='columnheader').length,2);assert.equal(nodes(tree).filter(n=>n.props.role==='cell').length,2);assert.ok(nodes(tree).some(n=>Array.isArray(n.props.style)&&n.props.style[1]?.textAlign==='right'));
 await nodes(tree).find(n=>n.props.accessibilityRole==='link')!.props.onPress();await Promise.resolve();tree=render({source:''});assert.ok(text(tree).includes('Could not open this link. Try again.'));
});

test('notes editor opens Markdown help from the icon chip and preserves editing',()=>{
 const render=component('NotesField.tsx','NotesField');const source='| Item | Amount |\n| --- | ---: |\n| Dinner | ₹500 |';const changed:string[]=[];const props={value:source,disabled:false,onChange:(v:string)=>changed.push(v)};
 let tree=render(props);let input=nodes(tree).find(n=>n.type==='TextField')!;assert.equal(input.props.maxLength,2000);assert.equal(input.props.value,source);assert.equal(input.props.multiline,true);assert.equal(input.props.label,'Notes (optional)');assert.equal(input.props.hideLabel,true);
 assert.ok(text(tree).includes(`${source.length}/2,000`));const chip=nodes(tree).find(n=>n.props.accessibilityLabel==='Markdown formatting help')!;assert.equal(chip.props.iconOnly,true);assert.equal(nodes(tree).find(n=>n.type==='KeyboardDialog')!.props.visible,false);chip.props.onPress();tree=render(props);assert.equal(nodes(tree).find(n=>n.type==='KeyboardDialog')!.props.visible,true);assert.ok(text(tree).includes('| Item | Amount |'));assert.equal(nodes(tree).filter(n=>n.props.title==='Preview'||n.props.title==='Formatting help').length,0);
 input.props.onChangeText('**Updated**');assert.deepEqual(changed,['**Updated**']);
 tree=render({...props,disabled:true});input=nodes(tree).find(n=>n.type==='TextField')!;assert.equal(input.props.value,source);assert.equal(input.props.editable,false);
});

test('link schemes are restricted to explicit web and email destinations',()=>{
 for(const value of ['javascript:alert(1)','data:text/html,abc','file:///private','merosplit://groups/a','//tracking.invalid','https://','https://ex\nample.com'])assert.equal(noteLink(value),null,value);
 for(const value of ['https://example.com/path?a=1&b=2','http://example.com','mailto:hello@example.com'])assert.equal(noteLink(value),value);
});
