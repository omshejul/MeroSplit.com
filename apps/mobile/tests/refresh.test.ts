import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { accountOwner, refreshGroups } from '../src/api.ts';
import { enqueue, migrate, pendingCommands, readDraft, readGroup, saveDraft, saveGroup } from '../src/storage.ts';
import { sqliteAdapter } from './sqlite.ts';
import type { Group, Session } from '../src/types.ts';
const session: Session = { baseUrl: 'https://refresh.test', token: 'synthetic', userId: 'one', email: 'one@example.test' };
const owner = accountOwner(session);
const group = (id: string, version: number): Group => ({ id, name: id, version, participants: [], expenses: [], settlements: [], balances: {}, transfers: [], activity: [] });

test('An unchanged complete index costs one request and zero cache writes', async () => {
  const raw = new DatabaseSync(':memory:'), db = sqliteAdapter(raw), original = globalThis.fetch, calls: string[] = [];
  try {
    await migrate(db); await saveGroup(db, owner, group('a', 1), 'shared'); await saveGroup(db, owner, group('b', 2), 'shared');
    const before = raw.prepare('SELECT total_changes() AS n').get()!.n;
    globalThis.fetch = async url => { calls.push(String(url)); return Response.json({ groups: [{ id: 'a', version: 1 }, { id: 'b', version: 2 }] }); };
    assert.deepEqual(await refreshGroups(db, session), []);
    assert.deepEqual(calls, ['https://refresh.test/api/v1/groups']);
    assert.equal(raw.prepare('SELECT total_changes() AS n').get()!.n, before);
  } finally { raw.close(); globalThis.fetch = original; }
});

test('Changed/missing/incomplete snapshots fetch fully and unaffected accounts remain intact', async () => {
  const raw = new DatabaseSync(':memory:'), db = sqliteAdapter(raw), original = globalThis.fetch, calls: string[] = [];
  try {
    await migrate(db); await saveGroup(db, owner, group('a', 1), 'shared'); await saveGroup(db, owner, group('b', 1), 'shared');
    await saveGroup(db, 'other-account', group('private', 10), 'shared');
    globalThis.fetch = async url => {
      calls.push(String(url));
      if (String(url).endsWith('/groups')) return Response.json({ groups: [{ id: 'a', version: 1 }, { id: 'b', version: 2 }, { id: 'c', version: 1 }] });
      return Response.json(String(url).endsWith('/b') ? group('b', 2) : group('c', 1));
    };
    await refreshGroups(db, session);
    assert.equal(calls.length, 3); assert.ok(!calls.some(url => url.endsWith('/a')));
    assert.equal((await readGroup(db, owner, 'b'))?.group.version, 2);
    assert.ok(await readGroup(db, 'other-account', 'private'));
    assert.ok(await readGroup(db, owner, 'c'));
  } finally { raw.close(); globalThis.fetch = original; }
});

test('A failed partial refresh never writes or prunes records, drafts or pending work', async () => {
  const raw = new DatabaseSync(':memory:'), db = sqliteAdapter(raw), original = globalThis.fetch;
  try {
    await migrate(db); await saveGroup(db, owner, group('a', 1), 'shared'); await saveGroup(db, owner, group('b', 1), 'shared');
    await saveDraft(db, owner, 'a', { description: 'Saved edit' });
    await enqueue(db, owner, { command_id: 'pending', group_id: 'a', method: 'POST', path: '/groups/a/expenses', body: {}, state: 'pending', error: null });
    const before = raw.prepare('SELECT total_changes() AS n').get()!.n;
    globalThis.fetch = async url => {
      if (String(url).endsWith('/groups')) return Response.json({ groups: [{ id: 'b', version: 2 }, { id: 'c', version: 1 }] });
      if (String(url).endsWith('/b')) return Response.json(group('b', 2));
      throw new Error('Dropped connection');
    };
    await assert.rejects(refreshGroups(db, session), /Could not connect/);
    assert.equal(raw.prepare('SELECT total_changes() AS n').get()!.n, before);
    assert.equal((await readGroup(db, owner, 'b'))?.group.version, 1);
    assert.ok(await readGroup(db, owner, 'a')); assert.deepEqual(await readDraft(db, owner, 'a'), { description: 'Saved edit' });
    assert.equal((await pendingCommands(db, owner)).length, 1);
  } finally { raw.close(); globalThis.fetch = original; }
});


test('old equal-version member caches refresh once for authoritative account email metadata', async () => {
  const raw=new DatabaseSync(':memory:'),db=sqliteAdapter(raw),original=globalThis.fetch,calls:string[]=[];
  const old={...group('a',1),participants:[{id:'p',name:'John',recorded_name:'John',user_id:2}]};
  const current={...old,participants:[{...old.participants[0],account_email:'actual@example.invalid'}]};
  try{
    await migrate(db);await saveGroup(db,owner,old,'shared');
    globalThis.fetch=async url=>{calls.push(String(url));return Response.json(String(url).endsWith('/groups')?{groups:[{id:'a',version:1}]}:current);};
    await refreshGroups(db,session);assert.equal(calls.length,2);assert.equal((await readGroup(db,owner,'a'))?.group.participants[0].account_email,'actual@example.invalid');
    calls.length=0;await refreshGroups(db,session);assert.equal(calls.length,1);
  }finally{raw.close();globalThis.fetch=original;}
});
