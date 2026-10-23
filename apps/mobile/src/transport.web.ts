import type { Session } from './types';
import { browserAccountRequest, makeBrowserSession } from './browserAuth.ts';

function sameOrigin(baseUrl: string): string {
  const normalized = new URL(baseUrl, window.location.origin);
  if (normalized.origin !== window.location.origin || !['http:', 'https:'].includes(normalized.protocol)) throw new Error('Open MeroSplit from its account server to sign in.');
  return normalized.origin;
}
function csrf(): string {
  return decodeURIComponent(document.cookie.split('; ').find(value => value.startsWith('csrftoken='))?.slice(10) ?? '');
}
export function sessionRequest(session: Session, path: string, init: RequestInit = {}, fetcher: typeof fetch = fetch): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.delete('X-Session-Token');
  headers.delete('X-MeroSplit-Account');
  if (session.userId) headers.set('X-MeroSplit-Account', session.userId);
  if (!['GET', 'HEAD', 'OPTIONS'].includes((init.method ?? 'GET').toUpperCase())) headers.set('X-CSRFToken', csrf());
  const url = `${sameOrigin(session.baseUrl)}${path}`;
  const send = () => fetcher(url, { ...init, headers, credentials: 'same-origin', mode: 'same-origin', referrerPolicy: 'same-origin' });
  return session.userId ? browserAccountRequest(send) : send();
}

export async function signOut(session: Session): Promise<void> {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await sessionRequest(session, '/_allauth/browser/v1/auth/session', { method: 'DELETE', signal: controller.signal })
      .catch(() => { throw new Error('Could not connect to sign out. Your saved changes remain in this browser. Try again when online.'); });
    if (!response.ok && response.status !== 401) throw new Error('Could not sign out. Try again.');
  } finally { clearTimeout(timer); }
}

export type { EmailCodeChallenge } from './emailCode.ts';
import { challengeFromResponse, emailCodeError } from './emailCode.ts';
import type { EmailCodeChallenge, EmailCodeResponse } from './emailCode.ts';
export async function requestEmailCode(baseUrl: string, email: string, emailRemindersDisclosed = false): Promise<EmailCodeChallenge> {
  const base = sameOrigin(baseUrl);
  if (!csrf()) await fetch(`${base}/app/`, { credentials: 'same-origin' });
  const response = await sessionRequest({ baseUrl: base } as Session, '/_allauth/browser/v1/auth/code/request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: email.trim(), email_reminders_disclosed: emailRemindersDisclosed }), signal: AbortSignal.timeout(15_000) });
  const data = await response.json() as EmailCodeResponse;
  if (!response.ok) throw new Error(emailCodeError(data, 'Could not request a sign-in code. Try again.'));
  return challengeFromResponse(data);
}
export async function confirmEmailCode(baseUrl: string, challengeId: string, code: string): Promise<Session> {
  const base = sameOrigin(baseUrl);
  const response = await sessionRequest({ baseUrl: base } as Session, '/_allauth/browser/v1/auth/code/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ challenge_id: challengeId, code, email_reminders_disclosed: true }), signal: AbortSignal.timeout(15_000) });
  const data = await response.json() as EmailCodeResponse;
  if (!response.ok || !data.data?.user || data.meta?.is_authenticated === false) throw new Error(emailCodeError(data, 'The code is incorrect or expired. Try again.'));
  return makeBrowserSession(base, { ...data.data.user, email: data.data.user.email ?? '' });
}
