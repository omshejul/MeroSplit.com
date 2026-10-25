import { captureGroupInvite } from './groupInvite.ts';
import type { AppLink } from './browserLinks';
const uuid = '[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}';
export function readAppLink(): AppLink | null {
  const groupInviteToken = captureGroupInvite();
  if (groupInviteToken) return { groupInviteToken };
  if (/^\/app\/invite\/join\/?$/.test(window.location.pathname)) return null;
  const invitation = window.location.pathname.match(/^\/app\/invite\/([^/]{1,512})\/?$/);
  if (invitation) { try { return { inviteToken: decodeURIComponent(invitation[1]) }; } catch { return null; } }
  const chat = window.location.pathname.match(new RegExp(`^/app/chat/(${uuid})/(${uuid})/?$`, 'i'));
  if (chat) return { groupId: chat[1], expenseId: chat[2], chat: true };
  const match = window.location.pathname.match(new RegExp(`^/app/groups/(${uuid})(?:/bills/(${uuid})(/chat|/versions)?)?/?$`, 'i'));
  if (match) return { groupId: match[1], ...(match[2] ? { expenseId: match[2], ...(match[3] === '/chat' ? { chat: true as const } : match[3] === '/versions' ? { versions: true as const } : {}) } : {}) };
  const params = new URLSearchParams(window.location.search), groupId = params.get('group'), expenseId = params.get('expense');
  return groupId && new RegExp(`^${uuid}$`, 'i').test(groupId) ? { groupId, ...(expenseId && new RegExp(`^${uuid}$`, 'i').test(expenseId) ? { expenseId } : {}) } : null;
}
export function subscribeAppLinks(callback: (target: AppLink | null) => void): () => void {
  const listener = () => callback(readAppLink()); window.addEventListener('popstate', listener); window.addEventListener('hashchange', listener);
  return () => { window.removeEventListener('popstate', listener); window.removeEventListener('hashchange', listener); };
}
export function writeAppLink(target: AppLink | null, options?: { replace?: boolean }): void {
  const path = target && 'groupInviteToken' in target ? '/app/invite/join' : target?.chat && target.groupId && target.expenseId ? `/app/chat/${encodeURIComponent(target.groupId)}/${encodeURIComponent(target.expenseId)}` : target?.inviteToken ? `/app/invite/${encodeURIComponent(target.inviteToken)}` : target?.groupId ? `/app/groups/${encodeURIComponent(target.groupId)}${target.expenseId ? `/bills/${encodeURIComponent(target.expenseId)}${target.chat ? '/chat' : target.versions ? '/versions' : ''}` : ''}` : '/app/';
  if (window.location.pathname !== path || window.location.search) window.history[options?.replace ? 'replaceState' : 'pushState'](null, '', path);
}
