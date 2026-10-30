import type { Session } from './types.ts';
import { sessionRequest } from './transport.ts';

export const GOOGLE_WEB_CLIENT_ID = '1091299527858-dmjm6sosrpqc7054m5nv6drpkgd03sma.apps.googleusercontent.com';
export const GOOGLE_IOS_CLIENT_ID = '1091299527858-189bnq3gr66tm2a1jsecvmd93n1s150a.apps.googleusercontent.com';
export type GoogleProcess = 'login' | 'connect';
export type GoogleAuthenticate = (stillCurrent: () => boolean) => Promise<Session | null>;
export class ProviderSignInError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}
type Reply = { data?: { nonce?: string; state?: string; expires_in?: number; client_id?: string; user?: { id: number; email: string } }; meta?: { session_token?: string; is_authenticated?: boolean }; errors?: { code?: string }[] };
export type GoogleAttempt = { session: Session; process: GoogleProcess; client: 'app' | 'browser'; nonce: string; expiresAt: number; provider?: 'google' | 'apple'; state?: string };

async function post(session: Session, client: GoogleAttempt['client'], action: 'challenge' | 'token', body: object, provider: 'google' | 'apple' = 'google'): Promise<Reply> {
  const label = provider === 'apple' ? 'Apple' : 'Google';
  const connecting = 'process' in body && body.process === 'connect';
  const unavailable = connecting ? `Couldn't connect ${label}. Please try again.` : `Could not sign in with ${label}. Try again or use email.`;
  const response = await sessionRequest(session, `/_allauth/${client}/v1/auth/${provider}/${action}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
  }).catch(() => { throw new Error(connecting ? unavailable : `Could not connect. Try ${label} again when online, or use email.`); });
  if (!response.headers.get('content-type')?.includes('json')) throw new Error(connecting ? unavailable : `${label} sign-in is temporarily unavailable. Use email or try later.`);
  let reply: Reply;
  try { reply = await response.json() as Reply; }
  catch { throw new Error(connecting ? unavailable : `${label} sign-in is temporarily unavailable. Use email or try later.`); }
  if (!response.ok) {
    const code = reply.errors?.[0]?.code;
    throw new ProviderSignInError(code ?? `${provider}_unavailable`, provider === 'apple' && code === 'apple_already_connected' ? 'This Apple ID is connected to another MeroSplit account. To access that account, sign out, then choose “Continue with Apple” on the sign-in screen.'
      : code === `${provider}_email_conflict` && !connecting ? `Sign in with your email first, then connect ${label} in Me.`
      : code === `${provider}_account_changed` ? 'Your signed-in account changed. Try again. Saved changes are safe.'
      : unavailable);
  }
  return reply;
}

export async function prepareGoogle(baseUrl: string, process: GoogleProcess, client: GoogleAttempt['client'], current?: Session, provider: 'google' | 'apple' = 'google'): Promise<GoogleAttempt> {
  const label = provider === 'apple' ? 'Apple' : 'Google';
  if ((process === 'connect') !== !!current || (current && current.baseUrl !== baseUrl)) throw new Error('Your signed-in account changed. Try again.');
  const session = current ?? { baseUrl, token: '', userId: '', email: '' };
  const reply = await post(session, client, 'challenge', { process }, provider);
  const data = reply.data;
  if (!data || !/^[a-f0-9]{64}$/.test(data.nonce ?? '') || data.client_id !== (provider === 'apple' ? 'com.omshejul.splitdumb' : GOOGLE_WEB_CLIENT_ID)
    || (provider === 'apple' && (client !== 'app' || !/^[a-f0-9]{64}$/.test(data.state ?? '')))
    || !Number.isInteger(data.expires_in) || data.expires_in! < 1 || data.expires_in! > 300) throw new Error(`Could not prepare ${label} sign-in. Try again.`);
  const token = client === 'app' ? reply.meta?.session_token ?? current?.token : session.token;
  if (client === 'app' && !token) throw new Error(`Could not prepare ${label} sign-in. Try again.`);
  return { session: { ...session, token: token ?? '' }, process, client, nonce: data.nonce!, expiresAt: Date.now() + data.expires_in! * 1000, ...(provider === 'apple' ? { provider, state: data.state } : {}) };
}

export async function finishGoogle(attempt: GoogleAttempt, credential: string, current: Session | undefined, stillCurrent: () => boolean, apple?: { authorization_code: string; state: string; given_name?: string; family_name?: string }): Promise<Session> {
  const label = attempt.provider === 'apple' ? 'Apple' : 'Google';
  if (!stillCurrent() || Date.now() >= attempt.expiresAt || typeof credential !== 'string' || !credential || credential.length > 16384) throw new Error(`${label} sign-in expired or your account changed. Try again.`);
  if (attempt.provider === 'apple' && (!apple || apple.state !== attempt.state || !apple.authorization_code || apple.authorization_code.length > 16384)) throw new Error('Apple sign-in expired. Try again.');
  const reply = await post(attempt.session, attempt.client, 'token', { process: attempt.process, id_token: credential, ...(attempt.provider === 'apple' ? apple : {}) }, attempt.provider);
  if (!stillCurrent()) throw new Error('Your signed-in account changed. Saved changes are safe.');
  const user = reply.data?.user;
  if (!user || !Number.isSafeInteger(user.id) || user.id <= 0 || typeof user.email !== 'string' || !user.email
    || reply.meta?.is_authenticated !== true) throw new Error( `Could not confirm ${label} sign-in. Reopen the app or use email.`);
  if (attempt.process === 'connect') {
    if (!current || String(user.id) !== current.userId) throw new Error('Your signed-in account changed. Saved changes are safe.');
    return current;
  }
  if (attempt.client === 'browser') {
    const { makeBrowserSession } = await import('./browserAuth.ts');
    return makeBrowserSession(attempt.session.baseUrl, user);
  }
  if (!reply.meta.session_token) throw new Error( `Could not confirm ${label} sign-in. Reopen the app or use email.`);
  return { baseUrl: attempt.session.baseUrl, userId: String(user.id), email: user.email, token: reply.meta.session_token };
}


// Public callback status only. Identity still comes from the browser session read.
export function googleBrowserError(search: string): string {
  const code = new URLSearchParams(search).get('google_error');
  return code === 'conflict' ? 'Sign in with your email first, then connect Google in Me.'
    : code === 'account_changed' ? 'Your signed-in account changed. Try again. Saved changes are safe.'
    : code === 'unavailable' ? 'Could not sign in with Google. Try again or use email.' : '';
}
