import type { Session } from './types';
import { cachedRead, invalidateRead, rememberRead, request } from './api';

export type ConnectedProvider = { id: string; provider: 'google' | 'apple'; uid: string; email: string; can_disconnect: boolean };
type Methods = { auto_link: boolean; accounts: ConnectedProvider[]; apple_revocation?: 'revoked' | 'manual_required' };
export type LinkedProviders = { google: boolean; apple: boolean; accounts: ConnectedProvider[]; autoLink: boolean; appleRevocation?: Methods['apple_revocation'] };
const path = '/me/sign-in-methods';
function parse(value: Methods): LinkedProviders {
  if (typeof value?.auto_link !== 'boolean' || !Array.isArray(value.accounts) || !value.accounts.every(account => account
    && ['google', 'apple'].includes(account.provider) && typeof account.id === 'string' && /^\d+$/.test(account.id)
    && typeof account.uid === 'string' && !!account.uid && typeof account.email === 'string' && typeof account.can_disconnect === 'boolean')) throw Error('Could not check connected accounts.');
  return { google: value.accounts.some(account => account.provider === 'google'), apple: value.accounts.some(account => account.provider === 'apple'), accounts: value.accounts, autoLink: value.auto_link, appleRevocation: value.apple_revocation };
}
export function cachedLinkedProviders(session: Session): LinkedProviders | null {
  const value = cachedRead<Methods>(session, path);
  return value ? parse(value) : null;
}
export function invalidateLinkedProviders(session: Session) { invalidateRead(session, path); }
export async function readLinkedProviders(session: Session, _client: 'app' | 'browser', signal: AbortSignal): Promise<LinkedProviders> {
  const value = await request<Methods>(session, path, 'GET', undefined, 'json', signal);
  try { return parse(value); } catch (error) { invalidateLinkedProviders(session); throw error; }
}
export async function updateLinkedProviders(session: Session, action: { autoLink: boolean } | { disconnect: string }): Promise<LinkedProviders> {
  const value = 'autoLink' in action
    ? await request<Methods>(session, `${path}/preferences`, 'PUT', { auto_link: action.autoLink })
    : await request<Methods>(session, `${path}/${encodeURIComponent(action.disconnect)}`, 'DELETE');
  const result = parse(value); rememberRead(session, path, value); return result;
}
