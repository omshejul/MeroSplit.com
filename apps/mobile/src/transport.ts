import type { Session } from './types.ts';
import { accountRequest } from './accountRequests.ts';

export function sessionRequest(session: Session, path: string, init: RequestInit = {}, fetcher: typeof fetch = fetch): Promise<Response> {
  return accountRequest(() => fetcher(`${session.baseUrl}${path}`, { ...init, headers: { ...init.headers, 'X-Session-Token': session.token } }));
}

export async function signOut(session: Session): Promise<void> {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await sessionRequest(session, '/_allauth/app/v1/auth/session', { method: 'DELETE', signal: controller.signal })
      .catch(() => { throw new Error('Could not connect to sign out. Your saved changes remain on this device. Try again when online.'); });
    if (!response.ok && response.status !== 401) throw new Error('Could not sign out. Try again.');
  } finally { clearTimeout(timer); }
}

export type { EmailCodeChallenge } from './emailCode.ts';
import { challengeFromResponse, emailCodeError } from './emailCode.ts';
import type { EmailCodeChallenge, EmailCodeResponse } from './emailCode.ts';
const preAuth = new Map<string, string>();
async function postEmailCode(base: string, action: 'request' | 'confirm', body: unknown, token?: string): Promise<{ response: Response; data: EmailCodeResponse }> {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(`${base}/_allauth/app/v1/auth/code/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Session-Token': token } : {}) }, body: JSON.stringify(body), signal: controller.signal })
      .catch(() => { throw new Error('Could not connect. Check your connection and try again.'); });
    if (!response.headers.get('content-type')?.includes('json')) throw new Error('Email sign-in is temporarily unavailable. Try again.');
    return { response, data: await response.json() as EmailCodeResponse };
  } finally { clearTimeout(timer); }
}
export async function requestEmailCode(baseUrl: string, email: string, emailRemindersDisclosed = false): Promise<EmailCodeChallenge> {
  const base = baseUrl.trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^/]+(?:\/[^?#]*)?$/.test(base)) throw new Error('Open a valid MeroSplit server.');
  const { response, data } = await postEmailCode(base, 'request', { email: email.trim(), email_reminders_disclosed: emailRemindersDisclosed });
  if (!response.ok) throw new Error(emailCodeError(data, 'Could not request a sign-in code. Try again.'));
  const challenge = challengeFromResponse(data); preAuth.clear();
  if (data.meta?.session_token) preAuth.set(challenge.challengeId, data.meta.session_token);
  return challenge;
}
export async function confirmEmailCode(baseUrl: string, challengeId: string, code: string): Promise<Session> {
  const base = baseUrl.trim().replace(/\/+$/, '');
  const { response, data } = await postEmailCode(base, 'confirm', { challenge_id: challengeId, code, email_reminders_disclosed: false }, preAuth.get(challengeId));
  if (!response.ok || !data.data?.user || !data.meta?.session_token || data.meta.is_authenticated === false) throw new Error(emailCodeError(data, 'The code is incorrect or expired. Try again.'));
  preAuth.delete(challengeId);
  return { baseUrl: base, userId: String(data.data.user.id), email: data.data.user.email ?? '', token: data.meta.session_token };
}
