import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { accountOwner, refreshGroups, retainHistoryWindow, syncOutbox } from '../src/api.ts';
import { migrate, saveGroup, readGroup, readVisibleGroup, listGroups, saveDraft, readDraft, enqueue, pendingCommands, reconcileGroupCache } from '../src/storage.ts';
import { previewPending } from '../src/ledger.ts';
import { sqliteAdapter } from './sqlite.ts';
import type { Group, Expense, Session, Command } from '../src/types.ts';
const session: Session = { baseUrl: 'https://browsing.test', userId: 'one', email: 'one@example.test', token: 'synthetic' }, owner = accountOwner(session);
const bill: Expense = { id: 'bill', version: 1, description: 'Tea', total: '900', paid: { a: '900', b: '0' }, shares: { a: '300', b: '600' }, split: { mode: 'exact', values: { a: '300', b: '600' } }, date: '2026-10-17', category: 'other', notes: '', deleted: false };
const full: Group = { attribution_version: 1, simplify_debts: true, id: 'g', name: 'Trip', version: 1, participants: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], expenses: [bill], settlements: [], activity: [], balances: { a: '600', b: '-600' }, transfers: [{ sender: 'b', recipient: 'a', amount: '600' }] };
const summary = (version = 1): Group => ({ ...full, version, participants: full.participants.map(person => ({ ...person, recorded_name: person.name, account_email: null })), read_mode: 'summary', expenses: [], transactions: [], totals: { spending: '900', paid: { a: '900', b: '0' }, shares: { a: '300', b: '600' } }, history: { transactions: { next_cursor: null }, bills: { next_cursor: 'signed' }, activity: { next_cursor: null }, settlements: { next_cursor: null }, attempts: { next_cursor: null } } });

test('Browsing pages live separately from complete snapshots and a newer version invalidates old text', async () => {
  const raw = new DatabaseSync(':memory:'), db = sqliteAdapter(raw);
  try {
    await migrate(db); await saveGroup(db, owner, full, 'shared'); await saveGroup(db, owner, summary(), 'shared');
    assert.equal((await readGroup(db, owner, 'g'))?.group.expenses.length, 1);
    assert.equal((await readVisibleGroup(db, owner, 'g'))?.group.read_mode, 'summary');
    assert.equal((await listGroups(db, owner)).length, 1);
    await saveGroup(db, owner, summary(2), 'shared');
    assert.equal(await readGroup(db, owner, 'g'), null, 'old complete history is invalidated rather than retaining redacted text');
    await saveGroup(db, owner, summary(1), 'shared');
    assert.equal((await readVisibleGroup(db, owner, 'g'))?.group.version, 2);
  } finally { raw.close(); }
});

test('Cold bounded refresh fetches summary only and unchanged refresh reuses its page with zero writes', async () => {
  const raw = new DatabaseSync(':memory:'), db = sqliteAdapter(raw), original = globalThis.fetch, calls: string[] = [];
  try {
    await migrate(db);
    globalThis.fetch = async url => { calls.push(String(url)); return Response.json(String(url).endsWith('/groups') ? { groups: [{ id: 'g', version: 1 }] } : summary()); };
    await refreshGroups(db, session, 'summary');
    assert.deepEqual(calls, ['https://browsing.test/api/v1/groups', 'https://browsing.test/api/v1/groups/g/summary']);
    const before = raw.prepare('SELECT total_changes() n').get()!.n; calls.length = 0;
    await refreshGroups(db, session, 'summary');
    assert.deepEqual(calls, ['https://browsing.test/api/v1/groups']);
    assert.equal(raw.prepare('SELECT total_changes() n').get()!.n, before);
  } finally { globalThis.fetch = original; raw.close(); }
});

test('A same-version summary from before canonical profile names refreshes once, then reuses the upgraded cache', async () => {
  const raw = new DatabaseSync(':memory:'), db = sqliteAdapter(raw), original = globalThis.fetch, calls: string[] = [];
  try {
    await migrate(db); await saveGroup(db, owner, { ...summary(), participants: full.participants }, 'shared');
    const canonical = { ...summary(), participants: summary().participants.map(person => ({ ...person, name: person.id === 'a' ? 'New canonical name' : person.name })) };
    globalThis.fetch = async url => { calls.push(String(url)); return Response.json(String(url).endsWith('/groups') ? { groups: [{ id: 'g', version: 1 }] } : canonical); };
    await refreshGroups(db, session, 'summary');
    assert.equal(calls.length, 2);
    assert.equal((await readVisibleGroup(db, owner, 'g'))?.group.participants[0].name, 'New canonical name');
    assert.deepEqual((await readVisibleGroup(db, owner, 'g'))?.group.balances, full.balances);
    calls.length = 0;
    await refreshGroups(db, session, 'summary');
    assert.equal(calls.length, 1, 'normal equal-version refresh remains bounded after the one-time upgrade');
  } finally { globalThis.fetch = original; raw.close(); }
});

test('Equal-version summaries from before the mixed timeline refresh once without changing finances', async () => {
  const raw = new DatabaseSync(':memory:'), db = sqliteAdapter(raw), original = globalThis.fetch, calls: string[] = [];
  try {
    await migrate(db); const old = summary(); delete old.transactions; delete old.history!.transactions;
    await saveGroup(db, owner, old, 'shared');
    globalThis.fetch = async url => { calls.push(String(url)); return Response.json(String(url).endsWith('/groups') ? { groups: [{ id: 'g', version: 1 }] } : summary()); };
    await refreshGroups(db, session, 'summary'); assert.equal(calls.length, 2);
    assert.deepEqual((await readVisibleGroup(db, owner, 'g'))?.group.balances, full.balances);
    calls.length = 0; await refreshGroups(db, session, 'summary'); assert.equal(calls.length, 1);
  } finally { globalThis.fetch = original; raw.close(); }
});

test('Bounded acknowledgments atomically retain accepted summary and clear immutable command, never claiming complete history', async () => {
  const raw = new DatabaseSync(':memory:'), db = sqliteAdapter(raw), original = globalThis.fetch;
  try {
    await migrate(db); await saveGroup(db, owner, summary(), 'shared');
    await enqueue(db, owner, { command_id: 'c', group_id: 'g', path: '/groups/g/expenses', method: 'POST', body: { command_id: 'c' }, state: 'pending', error: null });
    globalThis.fetch = async (url, init) => Response.json(init?.method === 'POST' ? { id: 'g', version: 2 } : summary(2));
    await syncOutbox(db, session, 'summary');
    assert.equal((await pendingCommands(db, owner)).length, 0);
    assert.equal((await readVisibleGroup(db, owner, 'g'))?.group.version, 2);
    assert.equal(await readGroup(db, owner, 'g'), null);
  } finally { globalThis.fetch = original; raw.close(); }
});

test('Revocation hides both cache forms, preserves pending work and never prunes after failed changed-group fetch', async () => {
  const raw = new DatabaseSync(':memory:'), db = sqliteAdapter(raw), original = globalThis.fetch;
  try {
    await migrate(db); await saveGroup(db, owner, full, 'shared'); await saveGroup(db, owner, summary(), 'shared'); await saveDraft(db, owner, 'g', { description: 'Keep this' });
    globalThis.fetch = async url => String(url).endsWith('/groups') ? Response.json({ groups: [{ id: 'other', version: 1 }] }) : Promise.reject(new Error('offline'));
    await assert.rejects(refreshGroups(db, session, 'summary'));
    assert.equal((await listGroups(db, owner)).length, 1);
    assert.deepEqual(await reconcileGroupCache(db, owner, []), ['g']);
    assert.equal((await listGroups(db, owner)).length, 0);
    assert.equal((await readVisibleGroup(db, owner, 'g'))?.kind, 'unavailable');
    assert.equal((await readGroup(db, owner, 'g'))?.kind, 'unavailable');
    assert.deepEqual(await readDraft(db, owner, 'g'), { description: 'Keep this' });
  } finally { globalThis.fetch = original; raw.close(); }
});

test('Missing older bill cannot create a false pending balance; one focused detail permits exact delta without loading all history', () => {
  const change: Command = { command_id: 'edit', group_id: 'g', base_version: 1, path: '/groups/g/expenses/bill', method: 'PUT', body: { ...bill, total: '1200', paid: { a: '1200', b: '0' }, split: { mode: 'exact', values: { a: '400', b: '800' } } }, state: 'pending', error: null };
  assert.throws(() => previewPending(summary(), [change]), /Open this saved bill/);
  const preview = previewPending({ ...summary(), focused_expense: bill }, [change]);
  assert.deepEqual(preview.balances, { a: '800', b: '-800' });
  assert.deepEqual(summary().totals?.spending, '900', 'complete accepted totals are independent of the displayed page');
});


test('Lost acknowledgments for backdated bills and old payments cannot double-count complete server balances', async () => {
  const accepted = { ...summary(2), balances: { a: '600', b: '-600' } };
  const billCommand: Command = { command_id: 'lost', group_id: 'g', base_version: 1, path: '/groups/g/expenses', method: 'POST', body: bill, state: 'pending', error: null };
  const payment: Command = { ...billCommand, path: '/groups/g/settlements', body: { id: 'old-payment', sender: 'b', recipient: 'a', amount: '100' } };
  for (const command of [billCommand, payment, { ...billCommand, base_version: undefined }]) assert.throws(() => previewPending(accepted, [command]), /Balances show accepted records/);
  assert.deepEqual(previewPending(summary(), [billCommand]).balances, { a: '1200', b: '-1200' }, 'known unchanged baseline permits an exact offline preview');
  const raw = new DatabaseSync(':memory:'), db = sqliteAdapter(raw);
  try { await migrate(db); await enqueue(db, owner, billCommand); assert.equal((await pendingCommands(db, owner))[0].base_version, 1); }
  finally { raw.close(); }
});


test('Upgrade a previously opened browsing database without changing old immutable command bodies', async () => {
  const raw = new DatabaseSync(':memory:'), db = sqliteAdapter(raw);
  try {
    await migrate(db); await enqueue(db, owner, { command_id: 'old', group_id: 'g', path: '/groups/g/expenses', method: 'POST', body: { command_id: 'old', description: 'Unsent old bill' }, state: 'pending', error: null });
    raw.exec('ALTER TABLE outbox DROP COLUMN base_version; PRAGMA user_version=3;');
    await migrate(db);
    const command = (await pendingCommands(db, owner))[0];
    assert.equal(command.command_id, 'old'); assert.equal(command.base_version, undefined);
    assert.deepEqual(command.body, { command_id: 'old', description: 'Unsent old bill' });
    assert.throws(() => previewPending(summary(), [command]), /Balances show accepted records/);
  } finally { raw.close(); }
});


test('appended history keeps the first page and refresh reuses it without discarding older loaded rows',async()=>{
  const raw=new DatabaseSync(':memory:'),db=sqliteAdapter(raw),original=globalThis.fetch,calls:string[]=[];
  const first={...bill,id:'newest',date:'2026-10-19'},older={...bill,id:'older',date:'2026-05-15'};
  const cached:Group={...summary(),expenses:[first,older],transactions:[{kind:'bill',date:first.date,bill:first},{kind:'bill',date:older.date,bill:older}],history:{...summary().history,transactions:{cursor:null,next_cursor:'even-older',query:'',previous:[]}}};
  try{
    await migrate(db);await saveGroup(db,owner,cached,'shared');
    globalThis.fetch=async url=>{calls.push(String(url));return Response.json({groups:[{id:'g',version:1}]});};
    await refreshGroups(db,session,'summary');
    assert.deepEqual(calls,[session.baseUrl+'/api/v1/groups']);
    assert.deepEqual((await readVisibleGroup(db,owner,'g'))?.group.transactions,cached.transactions);
  }finally{globalThis.fetch=original;raw.close();}
});


test('pre-setting caches refresh once at the same revision to discover group repayment mode', async () => {
  const raw=new DatabaseSync(':memory:'),db=sqliteAdapter(raw),original=globalThis.fetch,calls:string[]=[];
  try {
    await migrate(db); const legacy=summary(); delete legacy.simplify_debts; await saveGroup(db,owner,legacy,'shared');
    globalThis.fetch=async url=>{calls.push(String(url));return Response.json(String(url).endsWith('/groups')?{groups:[{id:'g',version:1}]}:{...summary(),simplify_debts:false});};
    await refreshGroups(db,session,'summary'); assert.equal(calls.length,2); assert.equal((await readVisibleGroup(db,owner,'g'))?.group.simplify_debts,false);
    calls.length=0;await refreshGroups(db,session,'summary');assert.equal(calls.length,1);
  } finally {globalThis.fetch=original;raw.close();}
});

test('a changed summary refetches the loaded history depth instead of dropping the older visible bill',async()=>{
 const raw=new DatabaseSync(':memory:'),db=sqliteAdapter(raw),original=globalThis.fetch;
 const row=(id:string)=>({kind:'bill' as const,date:bill.date,bill:{...bill,id}});
 const cached={...summary(),transactions:[row('first'),row('older')],history:{...summary().history,transactions:{cursor:null,next_cursor:'old-cursor',query:''}}};
 const latest={...summary(2),transactions:[row('first')],history:{...summary(2).history,transactions:{next_cursor:'new-cursor'}}};
 try{
  await migrate(db);await saveGroup(db,owner,cached,'shared');
  globalThis.fetch=async url=>{const path=String(url);if(path.endsWith('/groups'))return Response.json({groups:[{id:'g',version:2}]});if(path.endsWith('/summary'))return Response.json(latest);assert.ok(path.includes('version=2'));return Response.json({read_mode:'page',group_id:'g',version:2,items:[row('older')],next_cursor:null});};
  await refreshGroups(db,session,'summary');
  assert.deepEqual((await readVisibleGroup(db,owner,'g'))?.group.transactions?.map(row=>row.kind==='bill'?row.bill.id:row.payment.id),['first','older']);
 }finally{globalThis.fetch=original;raw.close();}
});

test('accepting an edited bill refetches the expanded history before replacing its cache',async()=>{
 const raw=new DatabaseSync(':memory:'),db=sqliteAdapter(raw),original=globalThis.fetch;
 const row=(id:string,description=id)=>({kind:'bill' as const,date:bill.date,bill:{...bill,id,description}});
 const cached={...summary(),transactions:[row('first'),row('older')],history:{...summary().history,transactions:{cursor:null,next_cursor:'old-cursor',query:''}}};
 try{
  await migrate(db);await saveGroup(db,owner,cached,'shared');await enqueue(db,owner,{command_id:'edit',group_id:'g',base_version:1,method:'PUT',path:'/groups/g/expenses/older',body:{id:'older'},state:'pending',error:null});
  globalThis.fetch=async(url,init)=>{if(init?.method==='PUT')return Response.json({id:'older',version:2});if(String(url).includes('/history/'))return Response.json({read_mode:'page',group_id:'g',version:2,items:[row('older','Updated body')],next_cursor:null});return Response.json({...summary(2),transactions:[row('first')],history:{...summary(2).history,transactions:{next_cursor:'new-cursor'}}});};
  await syncOutbox(db,session,'summary');const shown=(await readVisibleGroup(db,owner,'g'))!.group;assert.equal(shown.transactions?.length,2);assert.equal(shown.transactions?.[1].kind==='bill'?shown.transactions[1].bill.description:'','Updated body');assert.equal((await pendingCommands(db,owner)).length,0);
 }finally{globalThis.fetch=original;raw.close();}
});


test('history depth refresh rejects stale, foreign and revoked pages without reusing old text',async()=>{
 const original=globalThis.fetch,row=(id:string)=>({kind:'bill' as const,date:bill.date,bill:{...bill,id}});
 const previous={...summary(),transactions:[row('first'),row('older')]};
 const latest={...summary(2),transactions:[row('first')],history:{transactions:{next_cursor:'new'}}};
 try{
  for(const response of [{read_mode:'page',group_id:'g',version:1,items:[row('older')],next_cursor:null},{read_mode:'page',group_id:'other',version:2,items:[row('older')],next_cursor:null}]){
   globalThis.fetch=async()=>Response.json(response);await assert.rejects(retainHistoryWindow(session,latest,previous),/History changed/);
  }
  globalThis.fetch=async()=>new Response('',{status:403});await assert.rejects(retainHistoryWindow(session,latest,previous));
  let current=true;globalThis.fetch=async()=>{current=false;return Response.json({read_mode:'page',group_id:'g',version:2,items:[row('older')],next_cursor:null});};await assert.rejects(retainHistoryWindow(session,latest,previous,()=>current),/account changed/);
  assert.equal(latest.transactions.length,1,'failed pages never alter the supplied snapshot');
 }finally{globalThis.fetch=original;}
});


test('a live revision re-runs the active search and preserves downloaded matching history', async () => {
 const original=globalThis.fetch,calls:string[]=[];
 const row=(id:string)=>({kind:'bill' as const,date:bill.date,bill:{...bill,id,description:'Coffee '+id}});
 const previous={...summary(),transactions:[row('first'),row('older')],history:{...summary().history,transactions:{cursor:'old-search-page',next_cursor:'old-cursor',query:'Coffee'}}};
 const latest={...summary(2),transactions:[{...row('unrelated'),bill:{...bill,id:'unrelated',description:'Taxi'}}],history:{...summary(2).history,transactions:{next_cursor:'wrong-unfiltered-cursor'}}};
 try {
  globalThis.fetch=async input=>{const url=new URL(String(input));calls.push(url.href);assert.equal(url.searchParams.get('q'),'Coffee');assert.equal(url.searchParams.get('version'),'2');return Response.json({read_mode:'page',group_id:'g',version:2,items:[row(url.searchParams.has('cursor')?'older':'first')],next_cursor:url.searchParams.has('cursor')?null:'new-filtered-cursor'});};
  const refreshed=await retainHistoryWindow(session,latest,previous);
  assert.deepEqual(refreshed.transactions?.map(row=>row.kind==='bill'?row.bill.id:row.payment.id),['first','older']);
  assert.equal(refreshed.history?.transactions?.query,'Coffee');assert.equal(calls.length,2);
  const empty=await retainHistoryWindow(session,latest,{...previous,transactions:[]});assert.equal(empty.history?.transactions?.query,'Coffee');
 } finally {globalThis.fetch=original;}
});
