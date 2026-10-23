import type { AppLink } from './browserLinks';
const uuid = '[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}';
export function readAppLink(): AppLink | null {
  const invitation = window.location.pathname.match(/^\/app\/invite\/([^/]{1,512})\/?$/);
  if (invitation) { try { return { inviteToken: decodeURIComponent(invitation[1]) }; } catch { return null; } }
  const match = window.location.pathname.match(new RegExp(`^/app/groups/(${uuid})(?:/bills/(${uuid}))?/?$`, 'i'));
  if (match) return { groupId: match[1], ...(match[2] ? { expenseId: match[2] } : {}) };
  const params = new URLSearchParams(window.location.search), groupId = params.get('group'), expenseId = params.get('expense');
  return groupId && new RegExp(`^${uuid}$`, 'i').test(groupId) ? { groupId, ...(expenseId && new RegExp(`^${uuid}$`, 'i').test(expenseId) ? { expenseId } : {}) } : null;
}
export function subscribeAppLinks(callback: (target: AppLink | null) => void): () => void {
  const listener = () => callback(readAppLink()); window.addEventListener('popstate', listener);
  return () => window.removeEventListener('popstate', listener);
}
export function writeAppLink(target: AppLink | null, options?: { replace?: boolean }): void {
  const path = target?.inviteToken ? `/app/invite/${encodeURIComponent(target.inviteToken)}` : target?.groupId ? `/app/groups/${encodeURIComponent(target.groupId)}${target.expenseId ? `/bills/${encodeURIComponent(target.expenseId)}` : ''}` : '/app/';
  if (window.location.pathname !== path || window.location.search) window.history[options?.replace ? 'replaceState' : 'pushState'](null, '', path);
}
