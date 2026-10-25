import { groupInviteToken } from './groupInvite.ts';
import type { AppLink } from './browserLinks.ts';
import type { EmailLink } from './emailLink.ts';

export const APP_ORIGIN = 'https://merosplit.com';
const LEGACY_ORIGIN = 'https://merosplit.omshejul.com';

// Canonicalize links for sharing without changing transport or stored account keys.
export function publicAppUrl(value: string): string {
  const url = new URL(value, APP_ORIGIN);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid app link.');
  return `${APP_ORIGIN}${url.pathname}${url.search}${url.hash}`;
}
export type NativeLink = { kind: 'email'; link: EmailLink } | { kind: 'app'; target: AppLink };
export type NativeLinkSource = {
  getInitialURL(): Promise<string | null | undefined>;
  addEventListener(event: 'url', callback: (event: { url: string }) => void): { remove(): void };
};
const uuid = '[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}';
const emailPath = new RegExp(`^/app/sign-in/(${uuid})/?$`);
const groupPath = new RegExp(`^/app/groups/(${uuid})(?:/bills/(${uuid})(/chat)?)?/?$`);

export function parseNativeLink(value: string | null | undefined): NativeLink | null {
  if (!value || value.length > 2048 || /[\s\\?]/.test(value)) return null;
  const origin = [APP_ORIGIN, LEGACY_ORIGIN].find(host => value.startsWith(`${host}/`));
  if (!origin) return null;
  try {
    // RN's URL.hash truncates at '/'. Validate the original fragment instead.
    const pathAndHash = value.slice(origin.length), hashAt = pathAndHash.indexOf('#');
    const path = hashAt < 0 ? pathAndHash : pathAndHash.slice(0, hashAt), hash = hashAt < 0 ? '' : pathAndHash.slice(hashAt);
    if (path.split('/').some(segment => ['.', '..'].includes(decodeURIComponent(segment)))) return null;
    const email = path.match(emailPath);
    if (email) {
      const proof = hash.match(/^#proof=([A-Za-z0-9_-]{43,128})$/)?.[1] ?? null;
      return hash && !proof ? null : { kind: 'email', link: { id: email[1].toLowerCase(), proof } };
    }
    if (/^\/app\/invite\/join\/?$/.test(path)) {
      const token = groupInviteToken(hash);
      return token ? { kind: 'app', target: { groupInviteToken: token } } : null;
    }
    if (hash) return null;
    const short = origin === APP_ORIGIN && path.match(/^\/j\/([A-Za-z0-9_-]{32})$/);
    if (short) return { kind: 'app', target: { groupInviteToken: short[1] } };
    const group = path.match(groupPath);
    if (group) return { kind: 'app', target: { groupId: group[1].toLowerCase(), ...(group[2] ? { expenseId: group[2].toLowerCase(), ...(group[3] ? { chat: true as const } : {}) } : {}) } };
    const invitation = path.match(/^\/(?:app\/)?invite\/([^/]{1,1536})\/?$/);
    if (!invitation) return null;
    const inviteToken = decodeURIComponent(invitation[1]);
    return /^[A-Za-z0-9_.:-]{1,512}$/.test(inviteToken) && !['.', '..'].includes(inviteToken) ? { kind: 'app', target: { inviteToken } } : null;
  } catch { return null; }
}

// The caller owns auth hydration. Capture before it finishes, then let App queue
// the parsed target under its existing account/action guard. Never persist URLs.
export function startNativeLinks(source: NativeLinkSource, onLink: (link: NativeLink) => void | Promise<void>, onReady: () => void): () => void {
  let stopped = false, warmReceived = false, running = false;
  const pending: NativeLink[] = [], keys = new Set<string>();
  const key = (link: NativeLink) => link.kind === 'email' ? `email/${link.link.id}` : JSON.stringify(link.target);
  function drain(): void {
    if (stopped || running) return;
    const link = pending.shift();
    if (!link) return;
    running = true;
    const finish = () => { keys.delete(key(link)); running = false; drain(); };
    try { Promise.resolve(onLink(link)).then(finish, finish); } catch { finish(); }
  }
  function enqueue(link: NativeLink): void {
    const id = key(link);
    if (stopped || keys.has(id)) return;
    keys.add(id); pending.push(link); drain();
  }
  const subscription = source.addEventListener('url', event => {
    const link = parseNativeLink(event.url);
    if (link) { warmReceived = true; enqueue(link); }
  });
  void Promise.resolve().then(() => source.getInitialURL()).then(value => {
    if (!stopped && !warmReceived) { const link = parseNativeLink(value); if (link) enqueue(link); }
  }, () => {}).then(() => { if (!stopped) onReady(); });
  return () => { stopped = true; subscription.remove(); pending.length = 0; keys.clear(); };
}

// A receipt must prove both the accepted group write and the exact capability URL.
export function confirmedGroupInvite(groupId: string, value: Record<string, unknown>): string {
  const url = value.url;
  const parsed = typeof url === 'string' && url.startsWith(`${APP_ORIGIN}/j/`) ? parseNativeLink(url) : null;
  if (value.id !== groupId || !Number.isSafeInteger(value.version) || Number(value.version) < 1 || !parsed || parsed.kind !== 'app' || !('groupInviteToken' in parsed.target)) throw new Error('Could not confirm the invite link. Try again.');
  return url as string;
}
