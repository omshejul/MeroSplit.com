import { sessionRequest } from './transport.web.ts';
import { makeBrowserSession } from './browserAuth.ts';
import { emailTarget, emailLinkInspection, type EmailLinkInspection } from './emailLink.ts';
import { challengeFromResponse, type EmailCodeChallenge } from './emailCode.ts';
import type { EmailLinkResult } from './emailLink.ts';
import type { Session } from './types.ts';

export class EmailLinkError extends Error {
  status: number;
  constructor(status: number) {
    super(status === 429 ? 'Too many requests. Wait a little before trying again.' : status >= 500 ? 'Could not connect. Try again.' : 'This link has expired or was already used.');
    this.status = status;
  }
}
type Result = { data?: { user?: { id: string | number; email: string }; target?: unknown; needs_name?: boolean; retry_after?: number; accepted?: boolean; challenge_id?: string; expires_in?: number }; meta?: { is_authenticated?: boolean } };
async function post(baseUrl: string, action: 'request' | 'inspect' | 'exchange' | 'resume' | 'renew', body: unknown): Promise<Result> {
  if (typeof window === 'undefined' || new URL(baseUrl).origin !== window.location.origin) throw new EmailLinkError(400);
  const base = window.location.origin;
  if (!document.cookie.split('; ').some(value => value.startsWith('csrftoken='))) await fetch(`${base}/app/sign-in/`, { credentials: 'same-origin', cache: 'no-store' });
  let response: Response;
  try {
    response = await sessionRequest({ baseUrl: base } as Session, `/_allauth/browser/v1/auth/link/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15_000) });
  } catch { throw new EmailLinkError(503); }
  if (action === 'request' && response.status === 400) throw new Error('Check your email address and try again.');
  if (!response.ok || !response.headers.get('content-type')?.includes('json')) throw new EmailLinkError(response.status || 503);
  try { return await response.json() as Result; } catch { throw new EmailLinkError(503); }
}
function authenticated(baseUrl: string, result: Result): EmailLinkResult {
  if (!result.data?.user || result.meta?.is_authenticated === false || typeof result.data.needs_name !== 'boolean') throw new EmailLinkError(503);
  return { session: makeBrowserSession(baseUrl, result.data.user), target: emailTarget(result.data.target), needsName: result.data.needs_name };
}
export async function requestEmailLink(baseUrl: string, email: string): Promise<EmailCodeChallenge> {
  const result = await post(baseUrl, 'request', { email: email.trim(), email_reminders_disclosed: false });
  if (result.data?.accepted !== true) throw new Error('Could not send a sign-in link. Use a code instead.');
  return challengeFromResponse(result);
}
export async function inspectEmailLink(baseUrl: string, grantId: string, proof: string): Promise<EmailLinkInspection> {
  return emailLinkInspection((await post(baseUrl, 'inspect', { grant_id: grantId, proof })).data);
}
export async function exchangeEmailLink(baseUrl: string, grantId: string, proof: string, switchFromUserId?: number): Promise<EmailLinkResult> {
  return authenticated(baseUrl, await post(baseUrl, 'exchange', { grant_id: grantId, proof, ...(switchFromUserId === undefined ? {} : { switch_from_user_id: switchFromUserId }) }));
}
export async function resumeEmailLink(baseUrl: string, grantId: string): Promise<EmailLinkResult> {
  return authenticated(baseUrl, await post(baseUrl, 'resume', { grant_id: grantId }));
}
export async function renewEmailLink(baseUrl: string, grantId: string): Promise<number> {
  const result = await post(baseUrl, 'renew', { grant_id: grantId });
  if (result.data?.accepted !== true) throw new Error('Could not send a new link. Try again.');
  return result.data.retry_after ?? 60;
}

// Resolve one captured link. A newer navigation owns adoption once isCurrent
// becomes false, including when an older request has already changed the cookie.
export async function resolveEmailLink(baseUrl: string, link: Readonly<{ id: string; proof: string | null }>, isCurrent: () => boolean, switchFromUserId?: number): Promise<EmailLinkResult | null> {
  const { id, proof } = link;
  if (!isCurrent()) return null;
  if (switchFromUserId === undefined) {
    try {
      const resumed = await resumeEmailLink(baseUrl, id);
      return isCurrent() ? resumed : null;
    } catch {
      if (!isCurrent()) return null;
    }
  }
  if (!proof) throw new EmailLinkError(400);
  try {
    const exchanged = await exchangeEmailLink(baseUrl, id, proof, switchFromUserId);
    return isCurrent() ? exchanged : null;
  } catch (error) {
    if (!isCurrent()) return null;
    if (switchFromUserId !== undefined) throw error;
    try {
      const recovered = await resumeEmailLink(baseUrl, id);
      return isCurrent() ? recovered : null;
    } catch {
      if (!isCurrent()) return null;
      throw error;
    }
  }
}
