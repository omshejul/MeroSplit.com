import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';
import { ApiError, accountOwner, refreshGroups, syncOutbox, request } from '../src/api.ts';
import { enqueue, pendingCommands, migrate, saveGroup, readVisibleGroup } from '../src/storage.ts';
import { sqliteAdapter } from './sqlite.ts';
import type { Group, Session } from '../src/types.ts';

const source = ts.createSourceFile('App.tsx', readFileSync(new URL('../App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
function production(name: string, env: any) {
  let body = '';
  function visit(node: ts.Node) { if (ts.isFunctionDeclaration(node) && node.name?.text === name) body = node.getText(source); ts.forEachChild(node, visit); }
  visit(source); assert.ok(body);
  return new Function('env', `with(env){${ts.transpile(body, {target:ts.ScriptTarget.ES2022})};return ${name};}`)(env);
}

test('actual pull refresh recovers the October bill from a persisted May page at the same revision', async () => {
  const session: Session = { baseUrl: 'https://synthetic.invalid', userId: '1', email: 'synthetic@example.invalid', token: 'synthetic-only' };
  const parent=join(homedir(),'.codex','tmp');mkdirSync(parent,{recursive:true});const folder=mkdtempSync(join(parent,'merosplit-history-reopen-'));
  const file=join(folder,'history.sqlite'),owner=accountOwner(session),original=globalThis.fetch;let raw=new DatabaseSync(file),db=sqliteAdapter(raw);
  const bill = (id: string, description: string, date: string) => ({ id, description, date, total:'30000', paid:{self:'30000'}, shares:{self:'10000',second:'10000',third:'10000'}, deleted:false, version:1 });
  const october = bill('october', 'Garbage man', '2026-10-19'), may = bill('may', 'Electricity april', '2026-05-15');
  const page = (value: any, cursor: string | null): Group => ({ attribution_version:1, id:'g', name:'Synthetic house', version:100, read_mode:'summary', participants:['self','second','third'].map(id=>({id,name:id,recorded_name:id,account_email:null})), expenses:[value], settlements:[], activity:[], balances:{self:'20000',second:'-10000',third:'-10000'}, transfers:[], totals:{spending:'30000',paid:{self:'30000'},shares:{self:'10000',second:'10000',third:'10000'}}, transactions:[{kind:'bill',date:value.date,bill:value}], history:{transactions:{cursor,next_cursor:'next',previous:[]}} } as Group);
  let latest = page(october, null); const older = page(may, 'older-page');
  let offline = false, failHead = false, writes = 0; const november = bill('november', 'New bill', '2026-11-01');
  let done = Promise.resolve(), shown: Group | undefined;
  const paths: string[] = [];
  globalThis.fetch = async (url, init) => {
    if (offline) throw new TypeError('Offline');
    if (init?.method === 'POST') { writes++; latest = { ...page(november,null), version:101 }; return Response.json({id:'g',version:101}); }
    const path = new URL(String(url)).pathname; paths.push(path);
    if (path === '/api/v1/groups') return Response.json({groups:[{id:'g',version:latest.version}]});
    if (path === '/api/v1/groups/g/summary') { if (failHead) throw TypeError('Head unavailable'); return Response.json(latest); }
    if (path === '/api/v1/me/bill-email-entry') return Response.json({needs_invitation:false});
    throw Error('Unexpected request ' + path);
  };
  const env: any = { ApiError, session, screen:'group', tab:'Groups', selected:{group:older}, groupId:'g', ownerRef:{current:owner}, activeGroupRef:{current:'g'}, activeSessionRef:{current:session}, accountOwner, request, refreshGroups, syncOutbox,
    getDatabase:async()=>db, readProfile:async()=>{}, retryAccountMediaUploads:async()=>false, load:async(scope:string)=>{if(env.ownerRef.current===scope)shown=(await readVisibleGroup(db,scope,'g'))?.group;},
    setVerifiedEmptyOwner:()=>{}, setNeedsInvitation:()=>{}, setNotice:()=>{}, setGroupId:()=>{}, setScreen:()=>{}, setPulling:()=>{},
    perform:(fn:any)=>{done=fn();return done;} };
  try {
    await migrate(db); await saveGroup(db,owner,older,'shared'); await saveGroup(db,'other-account',older,'shared');
    raw.close();raw=new DatabaseSync(file);db=sqliteAdapter(raw); // real SQLite reopen, as on app restart
    env.authHeldRef={current:false}; env.publishIfChanged=async()=>{}; env.setSyncing=()=>{}; env.setSyncProblem=()=>{}; env.downloadOffline=()=>{}; env.accountRefresh={current:null}; env.runAccountRefresh=production('runAccountRefresh',env);
    env.syncAccount = production('syncAccount',env); env.sync = production('sync',env);
    production('pullToRefresh',env)(); await done;
    assert.equal(shown?.transactions?.[0].kind === 'bill' ? shown.transactions[0].bill.id : '', 'october', 'balances include the October bill, so a user refresh must recover the newest history page');
    assert.ok(!shown?.history?.transactions?.cursor);
    assert.deepEqual(shown?.balances,latest.balances);
    // A recovered head remains cheap and never touches another account's old page.
    paths.length=0; production('pullToRefresh',env)(); await done;
    assert.ok(!paths.includes('/api/v1/groups/g/summary'));
    assert.equal((await readVisibleGroup(db,'other-account','g'))?.group.history?.transactions?.cursor,'older-page');
    // A failed repair keeps saved balances/page instead of inventing an empty group.
    await saveGroup(db,owner,older,'shared'); failHead=true;
    production('pullToRefresh',env)(); await assert.rejects(done,/Could not connect/);
    assert.deepEqual((await readVisibleGroup(db,owner,'g'))?.group.balances,older.balances);
    failHead=false; production('pullToRefresh',env)(); await done;
    // A persisted filtered first page is not the unfiltered summary either.
    const filtered={...older,history:{transactions:{cursor:null,next_cursor:'filtered-next',query:'Electricity'}}};
    await saveGroup(db,owner,filtered,'shared'); production('pullToRefresh',env)(); await done;
    assert.equal(shown?.transactions?.[0].kind==='bill'?shown.transactions[0].bill.id:'','october','clearing a persisted search must not reuse filtered May rows');
    // Offline creation keeps its immutable command, then sync publishes the new head once.
    await enqueue(db,owner,{command_id:'new-command',group_id:'g',base_version:100,method:'POST',path:'/groups/g/expenses',body:{id:'november',command_id:'new-command'},state:'pending',error:null});
    offline=true; production('pullToRefresh',env)(); await assert.rejects(done,/Could not connect/);
    assert.equal((await pendingCommands(db,owner)).length,1); assert.equal(writes,0);
    offline=false; production('pullToRefresh',env)(); await done;
    assert.equal((await pendingCommands(db,owner)).length,0); assert.equal(writes,1);
    assert.equal(shown?.transactions?.[0].kind==='bill'?shown.transactions[0].bill.id:'','november');
    production('pullToRefresh',env)(); await done; assert.equal(writes,1);
    // A late old-account repair may update only its own cache, never the visible new account.
    await saveGroup(db,owner,{...older,version:101},'shared');shown=undefined;
    const fetch=globalThis.fetch;globalThis.fetch=async(url,init)=>{const response=await fetch(url,init);if(String(url).endsWith('/summary')){env.ownerRef.current='other-account';env.activeSessionRef.current={...session,token:'another-account'};}return response;};
    production('pullToRefresh',env)();await assert.rejects(done,/account changed/);
    assert.equal(shown,undefined);assert.equal((await readVisibleGroup(db,'other-account','g'))?.group.history?.transactions?.cursor,'older-page');


  } finally { globalThis.fetch=original; raw.close(); rmSync(folder,{recursive:true,force:true}); }
});
