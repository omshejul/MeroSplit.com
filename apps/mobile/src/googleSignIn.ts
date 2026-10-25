import type { Session } from './types.ts';
import { sessionRequest } from './transport.ts';

export const GOOGLE_WEB_CLIENT_ID = '1091299527858-dmjm6sosrpqc7054m5nv6drpkgd03sma.apps.googleusercontent.com';
export const GOOGLE_IOS_CLIENT_ID = '1091299527858-189bnq3gr66tm2a1jsecvmd93n1s150a.apps.googleusercontent.com';
export type GoogleProcess = 'login' | 'connect';
export type GoogleAuthenticate = (stillCurrent: () => boolean) => Promise<Session | null>;
type Reply = { data?: { nonce?: string; expires_in?: number; client_id?: string; user?: { id: number; email: string } }; meta?: { session_token?: string; is_authenticated?: boolean }; errors?: { code?: string }[] };
export type GoogleAttempt = { session: Session; process: GoogleProcess; client: 'app' | 'browser'; nonce: string; expiresAt: number };

async function post(session: Session, client: GoogleAttempt['client'], action: 'challenge' | 'token', body: object): Promise<Reply> {
  const response = await sessionRequest(session, `/_allauth/${client}/v1/auth/google/${action}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
  }).catch(() => { throw new Error('Could not connect. Try Google again when online, or use email.'); });
  if (!response.headers.get('content-type')?.includes('json')) throw new Error('Google sign-in is temporarily unavailable. Use email or try later.');
  let reply: Reply;
  try { reply = await response.json() as Reply; }
  catch { throw new Error('Google sign-in is temporarily unavailable. Use email or try later.'); }
  if (!response.ok) {
    const code = reply.errors?.[0]?.code;
    throw new Error(code === 'google_email_conflict' ? 'Sign in with your email first, then connect Google in Me.'
      : code === 'google_account_changed' ? 'Your signed-in account changed. Try again. Saved changes are safe.'
      : 'Could not sign in with Google. Try again or use email.');
  }
  return reply;
}

export async function prepareGoogle(baseUrl: string, process: GoogleProcess, client: GoogleAttempt['client'], current?: Session): Promise<GoogleAttempt> {
  if ((process === 'connect') !== !!current || (current && current.baseUrl !== baseUrl)) throw new Error('Your signed-in account changed. Try again.');
  const session = current ?? { baseUrl, token: '', userId: '', email: '' };
  const reply = await post(session, client, 'challenge', { process });
  const data = reply.data;
  if (!data || !/^[a-f0-9]{64}$/.test(data.nonce ?? '') || data.client_id !== GOOGLE_WEB_CLIENT_ID
    || !Number.isInteger(data.expires_in) || data.expires_in! < 1 || data.expires_in! > 300) throw new Error('Could not prepare Google sign-in. Try again.');
  const token = client === 'app' ? reply.meta?.session_token ?? current?.token : session.token;
  if (client === 'app' && !token) throw new Error('Could not prepare Google sign-in. Try again.');
  return { session: { ...session, token: token ?? '' }, process, client, nonce: data.nonce!, expiresAt: Date.now() + data.expires_in! * 1000 };
}

export async function finishGoogle(attempt: GoogleAttempt, credential: string, current: Session | undefined, stillCurrent: () => boolean): Promise<Session> {
  if (!stillCurrent() || Date.now() >= attempt.expiresAt || typeof credential !== 'string' || !credential || credential.length > 16384) throw new Error('Google sign-in expired or your account changed. Try again.');
  const reply = await post(attempt.session, attempt.client, 'token', { process: attempt.process, id_token: credential });
  if (!stillCurrent()) throw new Error('Your signed-in account changed. Saved changes are safe.');
  const user = reply.data?.user;
  if (!user || !Number.isSafeInteger(user.id) || user.id <= 0 || typeof user.email !== 'string' || !user.email
    || reply.meta?.is_authenticated !== true) throw new Error('Could not confirm Google sign-in. Reopen the app or use email.');
  if (attempt.process === 'connect') {
    if (!current || String(user.id) !== current.userId) throw new Error('Your signed-in account changed. Saved changes are safe.');
    return current;
  }
  if (attempt.client === 'browser') {
    const { makeBrowserSession } = await import('./browserAuth.ts');
    return makeBrowserSession(attempt.session.baseUrl, user);
  }
  if (!reply.meta.session_token) throw new Error('Could not confirm Google sign-in. Reopen the app or use email.');
  return { baseUrl: attempt.session.baseUrl, userId: String(user.id), email: user.email, token: reply.meta.session_token };
}
