import { useEffect, useRef } from 'react';
import { ApiError, readLedgerHeads } from './api';
import type { Session } from './types';

export type LedgerHead = { id: string; version: number; hidden?: boolean };
type Options = { enabled: boolean; heads: LedgerHead[]; safe: () => boolean; onRefresh: (ids: string[]) => Promise<void>; onExpired?: () => void };

// Versions are advisory. Only the ordinary authorized sync publishes ledger data.
export function changedLedgerGroups(remote: unknown, local: LedgerHead[]): string[] {
  if (!Array.isArray(remote) || remote.some(row => !row || typeof row.id !== 'string' || !row.id || !Number.isSafeInteger(row.version) || row.version < 0 || typeof row.hidden !== 'boolean') || new Set(remote.map(row => row.id)).size !== remote.length) throw new Error('Incomplete group versions.');
  const saved = new Map(local.map(row => [row.id, row])), ids = new Set<string>();
  for (const row of remote as LedgerHead[]) {
    const previous = saved.get(row.id);
    if (!previous || row.version > previous.version || row.version === previous.version && !!row.hidden !== !!previous.hidden) ids.add(row.id);
    saved.delete(row.id);
  }
  for (const id of saved.keys()) ids.add(id);
  return [...ids];
}

export function useLiveLedger(session: Session | null, options: Options): void {
  const scope = session ? JSON.stringify([session.baseUrl, session.userId, session.token]) : '';
  const latest = useRef({ ...options, scope }); latest.current = { ...options, scope };
  useEffect(() => {
    if (!session || !options.enabled) return;
    let stopped = false, failures = 0, timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const current = () => !stopped && !controller.signal.aborted && latest.current.enabled && latest.current.scope === scope;
    async function check() {
      let delay = 2_000;
      try {
        if (!current() || !latest.current.safe()) return;
        const result = await readLedgerHeads(session!, controller.signal);
        if (!current() || !latest.current.safe()) return;
        const ids = changedLedgerGroups(result.groups, latest.current.heads);
        if (ids.length) await latest.current.onRefresh(ids);
        failures = 0;
      } catch (error) {
        if (current() && error instanceof ApiError && [401, 403].includes(error.status)) { latest.current.onExpired?.(); stopped = true; }
        delay = Math.min(30_000, 2_000 * 2 ** Math.min(++failures, 4));
        // Saved content stays visible. Failed/deferred reads never acknowledge a version.
      } finally { if (current()) timer = setTimeout(() => void check(), delay); }
    }
    void check();
    return () => { stopped = true; controller.abort(); if (timer) clearTimeout(timer); };
  }, [session?.baseUrl, session?.userId, session?.token, options.enabled]);
}
