export type ExpenseNotice = { id: string; group_id: string; expense_id: string; expense_version: number; created_at: string };
export type NoticeFeed = { notices: ExpenseNotice[]; has_more: boolean };
export type NoticeSeen = { id: string; expense_version: number };
export type WindowFrame = { x: number; y: number; width: number; height: number };

export function noticeAcknowledgments(notices: ExpenseNotice[], groupId: string, expense: { id: string; version: number; deleted?: boolean }): NoticeSeen[] {
  if (expense.deleted || !Number.isSafeInteger(expense.version) || expense.version < 1) return [];
  return notices.filter(notice => notice.group_id === groupId && notice.expense_id === expense.id && notice.expense_version <= expense.version)
    .map(notice => ({ id: notice.id, expense_version: expense.version }));
}

export function visiblyIntersects(row: WindowFrame, viewport: WindowFrame | null): boolean {
  if (!viewport || [...Object.values(row), ...Object.values(viewport)].some(value => !Number.isFinite(value)) || row.width <= 0 || row.height <= 0 || viewport.width <= 0 || viewport.height <= 0) return false;
  const width = Math.max(0, Math.min(row.x + row.width, viewport.x + viewport.width) - Math.max(row.x, viewport.x));
  const height = Math.max(0, Math.min(row.y + row.height, viewport.y + viewport.height) - Math.max(row.y, viewport.y));
  return width * height >= Math.min(row.width, viewport.width) * Math.min(row.height, viewport.height) / 2;
}

/** A late response from a hidden or replaced session cannot refresh or expose its feed. */
export async function pollExpenseNotices(read: () => Promise<NoticeFeed>, current: () => boolean, refresh: (groupIds: string[]) => Promise<void>): Promise<NoticeFeed | null> {
  if (!current()) return null;
  const feed = await read();
  if (!current()) return null;
  if (feed.notices.length) await refresh([...new Set(feed.notices.map(notice => notice.group_id))]);
  return current() ? feed : null;
}

/** Global arrivals plus the current bounded bill page; neither query marks anything read. */
export async function readExpenseNotices(read: (path: string) => Promise<NoticeFeed>, visibleExpenseIds: string[] = []): Promise<NoticeFeed> {
  const ids = [...new Set(visibleExpenseIds)].slice(0, 50);
  const [global, scoped] = await Promise.all([
    read('/me/notifications?limit=50'),
    ids.length ? read(`/me/notifications?limit=50&expense_ids=${encodeURIComponent(ids.join(','))}`) : Promise.resolve({ notices: [], has_more: false }),
  ]);
  return { notices: [...new Map([...global.notices, ...scoped.notices].map(notice => [notice.id, notice])).values()], has_more: global.has_more || scoped.has_more };
}

export function matchesNoticePush(notice: ExpenseNotice, userId: string, data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  const payload = data as Record<string, unknown>;
  return payload.type === 'new_bill' && payload.recipient_user_id === userId
    && payload.event_id === notice.id && payload.group_id === notice.group_id && payload.expense_id === notice.expense_id
    && (payload.expense_version === undefined || payload.expense_version === notice.expense_version);
}
