import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesNoticePush, noticeAcknowledgments, pollExpenseNotices, readExpenseNotices, visiblyIntersects } from '../src/expenseNotices.ts';
import type { ExpenseNotice, NoticeFeed } from '../src/expenseNotices.ts';

const notice: ExpenseNotice = { id: 'notice-1', group_id: 'group-1', expense_id: 'bill-1', expense_version: 2, created_at: '2026-10-17T10:00:00Z' };
const feed: NoticeFeed = { notices: [notice], has_more: false };
const viewport = { x: 10, y: 100, width: 300, height: 500 };

test('acknowledgments bind notice, group and actual rendered revision; stale/deleted rows cannot mark seen', () => {
  assert.deepEqual(noticeAcknowledgments([notice], 'group-1', { id: 'bill-1', version: 2 }), [{ id: 'notice-1', expense_version: 2 }]);
  assert.deepEqual(noticeAcknowledgments([notice], 'group-1', { id: 'bill-1', version: 3 }), [{ id: 'notice-1', expense_version: 3 }]);
  for (const expense of [{ id: 'bill-1', version: 1 }, { id: 'bill-2', version: 2 }, { id: 'bill-1', version: 2, deleted: true }, { id: 'bill-1', version: NaN }]) assert.deepEqual(noticeAcknowledgments([notice], 'group-1', expense), []);
  assert.deepEqual(noticeAcknowledgments([notice], 'group-2', { id: 'bill-1', version: 2 }), []);
});

test('offscreen, unmeasured, zero-size and sliver rows are not visible; actual half-row intersection is', () => {
  assert.equal(visiblyIntersects({ x: 10, y: 600, width: 300, height: 80 }, viewport), false);
  assert.equal(visiblyIntersects({ x: 10, y: 599, width: 300, height: 80 }, viewport), false);
  assert.equal(visiblyIntersects({ x: 10, y: 560, width: 300, height: 80 }, viewport), true);
  assert.equal(visiblyIntersects({ x: 10, y: 100, width: 0, height: 80 }, viewport), false);
  assert.equal(visiblyIntersects({ x: 10, y: NaN, width: 300, height: 80 }, viewport), false);
  assert.equal(visiblyIntersects({ x: 10, y: 100, width: 300, height: 80 }, null), false);
  assert.equal(visiblyIntersects({ x: 309, y: 100, width: 300, height: 80 }, viewport), false);
});

test('a tall detail can be visible without requiring its offscreen content to fit the viewport', () => {
  assert.equal(visiblyIntersects({ x: 10, y: 100, width: 300, height: 2000 }, viewport), true);
  assert.equal(visiblyIntersects({ x: 10, y: 590, width: 300, height: 2000 }, viewport), false);
});

test('hidden/background polling performs no read or refresh', async () => {
  let calls = 0;
  assert.equal(await pollExpenseNotices(async () => { calls++; return feed; }, () => false, async () => { calls++; }), null);
  assert.equal(calls, 0);
});

test('account switch or hiding during a feed request cannot refresh old-account content', async () => {
  let current = true, refreshes = 0;
  const result = await pollExpenseNotices(async () => { current = false; return feed; }, () => current, async () => { refreshes++; });
  assert.equal(result, null); assert.equal(refreshes, 0);
});

test('poll refreshes unique canonical groups but never acknowledges or records engagement', async () => {
  const requests: string[][] = [];
  const value = { notices: [notice, { ...notice, id: 'second', expense_id: 'bill-2' }], has_more: false };
  assert.equal(await pollExpenseNotices(async () => value, () => true, async ids => { requests.push(ids); }), value);
  assert.deepEqual(requests, [['group-1']]);
  let current = true;
  assert.equal(await pollExpenseNotices(async () => feed, () => current, async () => { current = false; }), null);
});

test('visible older bill notices remain reachable beyond the global first page, with bounded deduped queries', async () => {
  const paths: string[] = [];
  const global = Array.from({ length: 50 }, (_, index) => ({ ...notice, id: `global-${index}`, expense_id: `other-${index}` }));
  const result = await readExpenseNotices(async path => { paths.push(path); return path.includes('expense_ids') ? feed : { notices: global, has_more: true }; }, ['bill-1', 'bill-1']);
  assert.equal(result.notices.length, 51); assert.equal(result.notices.at(-1)?.id, notice.id);
  assert.equal(paths.length, 2); assert.equal(new URL(paths[1], 'https://example.test').searchParams.get('expense_ids'), 'bill-1');
  const bounded: string[] = [];
  await readExpenseNotices(async path => { bounded.push(path); return feed; }, Array.from({ length: 80 }, (_, index) => String(index)));
  assert.equal(new URL(bounded[1], 'https://example.test').searchParams.get('expense_ids')?.split(',').length, 50);
  assert.equal((await readExpenseNotices(async () => feed, ['bill-1'])).notices.length, 1);
});

test('foreground suppression only matches the exact account and observed notice, never an unrelated push', () => {
  const payload = { type: 'new_bill', recipient_user_id: '42', event_id: notice.id, group_id: notice.group_id, expense_id: notice.expense_id, expense_version: 2 };
  assert.equal(matchesNoticePush(notice, '42', payload), true);
  for (const different of [{ recipient_user_id: '43' }, { event_id: 'other-notice' }, { group_id: 'other-group' }, { expense_id: 'other-bill' }, { expense_version: 3 }]) assert.equal(matchesNoticePush(notice, '42', { ...payload, ...different }), false);
  assert.equal(matchesNoticePush(notice, '42', null), false);
});
