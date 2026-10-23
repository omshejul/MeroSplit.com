import type { Session } from './types.ts';

export type EmailLink = { id: string | null; proof: string | null };
export type EmailTarget = { kind: 'home' } | { kind: 'group'; group_id: string };
export type EmailLinkResult = { session: Session; target: EmailTarget; needsName: boolean };
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
let pending: EmailLink | null = null;

export function parseEmailLink(pathname: string, hash: string): EmailLink | null {
  if (!pathname.startsWith('/app/sign-in/')) return null;
  const id = pathname.slice('/app/sign-in/'.length).replace(/\/$/, '');
  return { id: uuid.test(id) ? id : null, proof: hash.match(/^#proof=([A-Za-z0-9_-]{43,128})$/)?.[1] ?? null };
}
export function captureEmailLink(): EmailLink | null {
  if (typeof window === 'undefined') return null;
  const browser = window as Window & { __meroSplitEmailLink?: EmailLink };
  const captured = browser.__meroSplitEmailLink;
  delete browser.__meroSplitEmailLink;
  const value = captured ?? parseEmailLink(window.location.pathname, window.location.hash);
  if (!value) return null;
  if (value.proof || !pending || pending.id !== value.id) pending = value;
  if (window.location.hash || window.location.search) window.history.replaceState(null, '', value.id ? `/app/sign-in/${value.id}` : '/app/sign-in/');
  return pending;
}
export function forgetEmailProof(): void { pending = null; }
export function subscribeEmailLinks(onLink: (link: EmailLink) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const listener = () => { const value = captureEmailLink(); if (value) onLink(value); };
  window.addEventListener('hashchange', listener); window.addEventListener('popstate', listener);
  return () => { window.removeEventListener('hashchange', listener); window.removeEventListener('popstate', listener); };
}
export function emailTarget(value: unknown): EmailTarget {
  if (value && typeof value === 'object' && 'kind' in value) {
    if (value.kind === 'home') return { kind: 'home' };
    if (value.kind === 'group' && 'group_id' in value && typeof value.group_id === 'string' && uuid.test(value.group_id)) return { kind: 'group', group_id: value.group_id };
  }
  throw new Error('This page is not available.');
}
