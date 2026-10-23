import type { AppLink } from './browserLinks.ts';
import type { EmailLink } from './emailLink.ts';

export const APP_ORIGIN = 'https://merosplit.omshejul.com';
export type NativeLink = { kind: 'email'; link: EmailLink } | { kind: 'app'; target: AppLink };
export type NativeLinkSource = {
  getInitialURL(): Promise<string | null | undefined>;
  addEventListener(event: 'url', callback: (event: { url: string }) => void): { remove(): void };
};
const uuid = '[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}';
const emailPath = new RegExp(`^/app/sign-in/(${uuid})/?$`);
const groupPath = new RegExp(`^/app/groups/(${uuid})(?:/bills/(${uuid}))?/?$`);

export function parseNativeLink(value: string | null | undefined): NativeLink | null {
  if (!value || value.length > 2048 || !value.startsWith(`${APP_ORIGIN}/`) || /[\s\\?]/.test(value)) return null;
  try {
    // RN's URL.hash truncates at '/'. Validate the original fragment instead.
    const pathAndHash = value.slice(APP_ORIGIN.length), hashAt = pathAndHash.indexOf('#');
    const path = hashAt < 0 ? pathAndHash : pathAndHash.slice(0, hashAt), hash = hashAt < 0 ? '' : pathAndHash.slice(hashAt);
    if (path.split('/').some(segment => ['.', '..'].includes(decodeURIComponent(segment)))) return null;
    const email = path.match(emailPath);
    if (email) {
      const proof = hash.match(/^#proof=([A-Za-z0-9_-]{43,128})$/)?.[1] ?? null;
      return hash && !proof ? null : { kind: 'email', link: { id: email[1].toLowerCase(), proof } };
    }
    if (hash) return null;
    const group = path.match(groupPath);
    if (group) return { kind: 'app', target: { groupId: group[1].toLowerCase(), ...(group[2] ? { expenseId: group[2].toLowerCase() } : {}) } };
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
