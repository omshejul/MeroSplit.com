import test from 'node:test';
import assert from 'node:assert/strict';
import { groupListRows } from '../src/groupListRows.ts';
import { visiblePeopleSummary } from '../src/personalBalances.ts';
import type { CachedGroup } from '../src/types.ts';

function row(id: string, archived?: boolean, direct = false): CachedGroup {
  return { kind: 'shared', group: { id, name: id, version: 1, archived, is_direct: direct,
    participants: [{ id: 'self', name: 'You', user_id: 1 }, { id: 'other', name: 'Noor', user_id: 2 }],
    balances: { self: '-100', other: '100' }, transfers: [{ sender: 'self', recipient: 'other', amount: '100' }], expenses: [], settlements: [], activity: [] } };
}
test('default Groups excludes archived rows; explicit archive retains debt and original canonical objects', () => {
  const rows = [row('active'), row('archive', true), row('explicit-active', false), row('person', true, true)];
  const before = structuredClone(rows);
  assert.deepEqual(groupListRows(rows).map(value => value.group.id), ['active', 'explicit-active']);
  const archived = groupListRows(rows, true);
  assert.deepEqual(archived.map(value => value.group.id), ['archive']);
  assert.equal(archived[0], rows[1]); assert.equal(archived[0].group.balances.self, '-100');
  assert.deepEqual(rows, before, 'display filtering must not prune canonical rows or alter obligations');
  assert.equal(visiblePeopleSummary(rows[3].group, '1'), true, 'archived direct debt retains existing People semantics');
});
test('reopening moves a row back to active display without changing either canonical list length or ordering', () => {
  const rows = [row('older', true), row('active'), row('newer', true)];
  rows[0].group.archived = false;
  assert.deepEqual(groupListRows(rows).map(value => value.group.id), ['older', 'active']);
  assert.deepEqual(groupListRows(rows, true).map(value => value.group.id), ['newer']);
  assert.equal(rows.length, 3);
  assert.deepEqual(groupListRows([]), []);
});
