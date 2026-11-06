import type { Session } from './types';

type Load = (signal: AbortSignal) => Promise<unknown>;
type Entry = { controller: AbortController; load: Load; promise: Promise<unknown>; resolve: (value: unknown) => void; reject: (error: unknown) => void; started: boolean; finished: boolean; speculative: boolean; scope: string; value?: unknown; expires: number };
const clone = <T,>(value: T): T => value === undefined ? value : JSON.parse(JSON.stringify(value));
export const readScope = (session: Session) => JSON.stringify([session.baseUrl, session.userId, session.token]);
export function prefetchTTL(path: string): number {
  if (path === '/activity?limit=50' || path === '/me/chat-conversations?limit=20') return 30_000;
  if (path === '/me' || path === '/me/notifications/preferences' || path === '/me/sign-in-methods' || path === '/me/balance-statements/preferences') return 60_000;
  if (/^\/groups\/[^/]+\/(expenses|settlements)\/[^/?]+\?version=\d+$/.test(path)) return 60_000;
  return 0;
}

// Memory only. No credentials or speculative results are persisted.
export class ReadPrefetch {
  private scope = '';
  private enabled = false;
  private entries = new Map<string, Entry>();
  private running = 0;
  private now: () => number;
  constructor(now = () => Date.now()) { this.now = now; }
  configure(scope: string, enabled: boolean) {
    if (scope !== this.scope) { this.clear(); this.scope = scope; }
    this.enabled = enabled;
    if (!enabled) for (const [key, entry] of [...this.entries]) if (entry.speculative && !entry.finished) this.expire(key, entry);
    this.pump();
  }
  invalidate(scope: string, path?: string) {
    if (scope !== this.scope) return;
    for (const [key, entry] of [...this.entries]) if (!path || key === path) this.expire(key, entry);
  }
  confirm<T>(scope: string, path: string, value: T) {
    if (scope !== this.scope || !prefetchTTL(path)) return;
    const entry = this.create(path, async () => value, false);
    entry.value = clone(value); entry.started = entry.finished = true;
    entry.expires = this.now() + prefetchTTL(path); entry.resolve(clone(value));
  }
  peek<T>(scope: string, path: string): T | undefined {
    if (scope !== this.scope) return undefined;
    return clone(this.entries.get(path)?.value as T | undefined);
  }
  fresh(scope: string, path: string) { const entry = scope === this.scope ? this.entries.get(path) : undefined; return !!entry && entry.value !== undefined && entry.expires > this.now(); }
  read<T>(scope: string, path: string, load: Load, signal?: AbortSignal): Promise<T> {
    if (!prefetchTTL(path) || scope !== this.scope) return load(signal ?? new AbortController().signal) as Promise<T>;
    if (signal?.aborted) return Promise.reject(new Error('Read cancelled'));
    if (this.fresh(scope, path)) return Promise.resolve(this.peek<T>(scope, path)!);
    let entry = this.entries.get(path);
    if (!entry || entry.finished) entry = this.create(path, load, false);
    entry.speculative = false; // A tap promotes queued work and survives a prefetch pause.
    if (!entry.started) this.start(path, entry);
    const promise = entry.promise.then(value => clone(value) as T);
    if (!signal) return promise;
    return new Promise<T>((resolve, reject) => {
      const cancel = () => reject(new Error('Read cancelled'));
      signal.addEventListener('abort', cancel, { once: true });
      promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
    });
  }
  warm<T>(scope: string, path: string, load: Load): Promise<T | undefined> {
    if (!this.enabled || scope !== this.scope || !prefetchTTL(path)) return Promise.resolve(undefined);
    if (this.fresh(scope, path)) return Promise.resolve(this.peek<T>(scope, path));
    let entry = this.entries.get(path);
    if (!entry && this.entries.size >= 64) return Promise.resolve(undefined);
    if (!entry || entry.finished) entry = this.create(path, load, true);
    this.pump();
    return entry.promise.then(value => clone(value) as T, () => undefined);
  }
  private create(path: string, load: Load, speculative: boolean): Entry {
    const value = clone(this.entries.get(path)?.value);
    // Keep the memory budget bounded. Never evict an active foreground read.
    if (this.entries.size >= 64) for (const [key, entry] of this.entries) if (entry.value !== undefined) { this.entries.delete(key); break; }
    let resolve!: Entry['resolve'], reject!: Entry['reject'];
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    const entry = { controller: new AbortController(), load, promise, resolve, reject, started: false, finished: false, speculative, scope: this.scope, value, expires: 0 };
    this.entries.set(path, entry); return entry;
  }
  private start(path: string, entry: Entry) {
    entry.started = true; this.running++;
    void Promise.resolve().then(() => {
      if (entry.controller.signal.aborted) throw new Error('Read cancelled');
      return entry.load(entry.controller.signal);
    }).then(value => {
      if (entry.scope !== this.scope || entry.controller.signal.aborted) throw new Error('Read cancelled');
      if (this.entries.get(path) === entry) { entry.value = clone(value); entry.expires = this.now() + prefetchTTL(path); }
      entry.finished = true;
      entry.resolve(value);
    }).catch(error => { entry.finished = true; if (this.entries.get(path) === entry) { if (entry.value === undefined) this.entries.delete(path); else entry.expires = 0; } entry.reject(error); })
      .finally(() => { this.running--; this.pump(); });
  }
  private pump() {
    if (!this.enabled) return;
    for (const [path, entry] of this.entries) {
      if (this.running >= 2) break;
      if (!entry.started && entry.speculative) this.start(path, entry);
    }
  }
  private cancel(key: string, entry: Entry) { this.entries.delete(key); entry.controller.abort(); entry.reject(new Error('Read cancelled')); }
  private expire(path: string, entry: Entry) {
    if (entry.speculative) this.cancel(path, entry); else this.entries.delete(path);
    // Retain confirmed details for painting, never the validity or pending read.
    if (entry.value !== undefined) this.entries.set(path, { ...entry, finished: true, speculative: false, expires: 0 });
  }
  private clear(cancelDemand = true) { for (const [key, entry] of this.entries) { if (cancelDemand || entry.speculative) this.cancel(key, entry); else this.entries.delete(key); } }
}
export const readPrefetch = new ReadPrefetch();
