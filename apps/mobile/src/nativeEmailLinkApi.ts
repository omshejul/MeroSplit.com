import { challengeFromResponse, type EmailCodeChallenge } from './emailCode.ts';
import { emailTarget, type EmailLinkResult } from './emailLink.ts';
import type { Session } from './types.ts';

export class NativeEmailLinkError extends Error {
  status: number;
  constructor(status: number, uncertain = false) {
    super(uncertain ? 'Could not confirm sign-in. Send a new link to continue.' : status === 429 ? 'Too many requests. Wait a little before trying again.' : status >= 500 ? 'Could not connect. Try again.' : 'This link has expired or was already used.');
    this.status = status;
  }
}
type Result = {
  data?: { user?: { id: string | number; email: string; display_name?: string }; target?: unknown; needs_name?: boolean; accepted?: boolean; challenge_id?: string; expires_in?: number; retry_after?: number };
  meta?: { is_authenticated?: boolean; session_token?: string };
};
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
function server(baseUrl: string): string {
  try {
    const base = baseUrl.trim().replace(/\/+$/, ''), url = new URL(base);
    if (!['https:', 'http:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) throw new Error();
    return base;
  } catch { throw new NativeEmailLinkError(400); }
}
function validToken(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && /^[\x21-\x7e]+$/.test(value) && !value.startsWith('browser-session:');
}
function currentFor(base: string, current?: Session): Session | undefined {
  try {
    if (!current || server(current.baseUrl) !== base || !/^[1-9]\d*$/.test(current.userId) || !validToken(current.token)) return undefined;
    return { ...current };
  } catch { return undefined; }
}
async function post(base: string, action: 'request' | 'exchange' | 'resume' | 'renew', body: unknown, current: Session | undefined, fetcher: typeof fetch): Promise<Result> {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15_000);
  try {
    let response: Response;
    try {
      response = await fetcher(`${base}/_allauth/app/v1/auth/link/${action}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...(current ? { 'X-Session-Token': current.token } : {}) },
        body: JSON.stringify(body), credentials: 'omit', cache: 'no-store', redirect: 'error', signal: controller.signal,
      });
    } catch { throw new NativeEmailLinkError(503); }
    if (action === 'request' && response.status === 400) throw new Error('Check your email address and try again.');
    if (!response.ok) throw new NativeEmailLinkError(response.status);
    if (!response.headers.get('content-type')?.includes('json')) throw new NativeEmailLinkError(503);
    try { return await response.json() as Result; } catch { throw new NativeEmailLinkError(503); }
  } finally { clearTimeout(timer); }
}
function authenticated(base: string, result: Result, current?: Session, resume = false): EmailLinkResult {
  const user = result.data?.user, userId = String(user?.id ?? '');
  if (!user || !/^[1-9]\d*$/.test(userId) || typeof user.email !== 'string' || !user.email.trim()
    || result.meta?.is_authenticated !== true || typeof result.data?.needs_name !== 'boolean'
    || user.display_name !== undefined && typeof user.display_name !== 'string'
    || resume && userId !== current?.userId) throw new NativeEmailLinkError(503);
  const supplied = result.meta.session_token;
  const token = supplied === undefined && current?.userId === userId ? current.token : supplied;
  if (!validToken(token) || current && userId !== current.userId && token === current.token) throw new NativeEmailLinkError(503);
  let target;
  try { target = emailTarget(result.data.target); } catch { throw new NativeEmailLinkError(503); }
  // Persistence belongs to App's existing SecureStore adoption after its epoch
  // check. Neither proof nor a provisional session is cached in this module.
  return { session: { baseUrl: base, userId, email: user.email, displayName: user.display_name ?? '', token }, target, needsName: result.data.needs_name };
}
export async function requestNativeEmailLink(baseUrl: string, email: string, fetcher: typeof fetch = fetch): Promise<EmailCodeChallenge> {
  const result = await post(server(baseUrl), 'request', { email: email.trim(), email_reminders_disclosed: true }, undefined, fetcher);
  if (result.data?.accepted !== true) throw new Error('Could not send a sign-in link. Use a code instead.');
  if (!uuid.test(result.data.challenge_id ?? '')) throw new NativeEmailLinkError(503);
  return challengeFromResponse(result);
}
export async function exchangeNativeEmailLink(baseUrl: string, grantId: string, proof: string, currentSession?: Session, fetcher: typeof fetch = fetch): Promise<EmailLinkResult> {
  const base = server(baseUrl), current = currentFor(base, currentSession);
  return authenticated(base, await post(base, 'exchange', { grant_id: grantId, proof }, current, fetcher), current);
}
export async function resumeNativeEmailLink(baseUrl: string, grantId: string, currentSession: Session, fetcher: typeof fetch = fetch): Promise<EmailLinkResult> {
  const base = server(baseUrl), current = currentFor(base, currentSession);
  if (!current) throw new NativeEmailLinkError(401);
  return authenticated(base, await post(base, 'resume', { grant_id: grantId }, current, fetcher), current, true);
}
export async function renewNativeEmailLink(baseUrl: string, grantId: string, fetcher: typeof fetch = fetch): Promise<number> {
  const result = await post(server(baseUrl), 'renew', { grant_id: grantId }, undefined, fetcher);
  if (result.data?.accepted !== true) throw new Error('Could not send a new link. Try again.');
  return result.data.retry_after ?? 60;
}

export async function resolveNativeEmailLink(baseUrl: string, link: Readonly<{ id: string; proof: string | null }>, isCurrent: () => boolean, currentSession?: Session, fetcher: typeof fetch = fetch): Promise<EmailLinkResult | null> {
  const base = server(baseUrl), { id, proof } = link;
  let current = currentFor(base, currentSession);
  if (!isCurrent()) return null;
  if (current) {
    try {
      const resumed = await resumeNativeEmailLink(base, id, current, fetcher);
      return isCurrent() ? resumed : null;
    } catch (error) {
      if (!isCurrent()) return null;
      // Allauth rejects an invalid native session before dispatching the view;
      // do not keep sending that rejected token with a valid fresh proof.
      if (error instanceof NativeEmailLinkError && [401, 410].includes(error.status)) current = undefined;
    }
  }
  if (!proof) throw new NativeEmailLinkError(400);
  try {
    const exchanged = await exchangeNativeEmailLink(base, id, proof, current, fetcher);
    return isCurrent() ? exchanged : null;
  } catch (error) {
    if (!isCurrent()) return null;
    if (current) {
      try {
        const recovered = await resumeNativeEmailLink(base, id, current, fetcher);
        return isCurrent() ? recovered : null;
      } catch {
        if (!isCurrent()) return null;
      }
    }
    // Anonymous login and a wrong-account switch rotate the session key. If
    // that response was lost there is no preauth token to resume: renew the
    // known selector, never invent/adopt a token or automatically exchange twice.
    if (error instanceof NativeEmailLinkError && error.status >= 500) throw new NativeEmailLinkError(error.status, true);
    throw error;
  }
}
