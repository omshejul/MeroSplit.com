import { useEffect, useRef, useSyncExternalStore } from 'react';
import { accountOwner, ApiError, request } from './api';
import { getDatabase } from './native';
import { cachedExpenseIcons, subscribeExpenseIcons, saveExpenseIcons, clearExpenseIcons } from './expenseIconCache';
import { categoryKey, categoryIcon } from './categoryIcons';
import type { ExpenseIconRef, ExpenseIcons } from './categoryIcons';
import type { Session } from './types';

type Hint = { id: string; group_id: string; title: string; category: string | null; state: string };
const pendingDelays = [5_000, 15_000, 30_000];

export function useExpenseIcons(session: Session | null, visible: ExpenseIconRef[], active: boolean, online: boolean, batchAll = false): ExpenseIcons {
  const refs = [...new Map(visible.map(ref => [ref.id, ref])).values()].sort((a, b) => a.id.localeCompare(b.id)).slice(0, batchAll ? undefined : 20);
  const owner = session ? accountOwner(session) : '';
  const account = session ? `${owner}|${session.token}` : '';
  const query = JSON.stringify(refs), scope = `${account}|${active}|${online}|${query}`;
  const current = useRef(scope); current.current = scope;
  const saved = useSyncExternalStore(subscribeExpenseIcons, () => cachedExpenseIcons(owner), () => cachedExpenseIcons(owner));
  useEffect(() => {
    if (!session || !active || !online || !refs.length) return;
    let stopped = false, timer: ReturnType<typeof setTimeout> | undefined, attempt = 0;
    const controller = new AbortController();
    const valid = () => !stopped && !controller.signal.aborted && current.current === scope;
    async function read() {
      try {
        const items: Hint[] = [];
        for (let offset = 0; offset < refs.length; offset += 20) {
          const batch = refs.slice(offset, offset + 20);
          const result = await request<{ items: Hint[] }>(session!, `/expense-icons?ids=${encodeURIComponent(batch.map(ref => ref.id).join(','))}`, 'GET', undefined, 'json', controller.signal);
          if (!valid() || !Array.isArray(result.items)) return;
          items.push(...result.items);
        }
        let pending = false;
        const values: ExpenseIcons = {};
        for (const ref of refs) {
          const hint = items.find(row => row.id === ref.id && row.group_id === ref.groupId && row.title === ref.title);
          if (!hint) continue;
          pending ||= hint.state === 'pending';
          if (['ready', 'manual'].includes(hint.state) && hint.category && (categoryIcon(hint.category) !== 'bill' || hint.category === 'general')) values[categoryKey(ref.groupId, ref.id, ref.title)] = hint.category;
        }
        const db = await getDatabase();
        if (!valid()) return;
        await saveExpenseIcons(db, owner, values);
        if (!valid()) return;
        if (pending && attempt < pendingDelays.length) timer = setTimeout(() => void read(), pendingDelays[attempt++]);
      } catch (cause) {
        if (valid() && cause instanceof ApiError && [401, 403, 404].includes(cause.status)) {
          const db = await getDatabase().catch(() => null);
          if (db && valid()) await clearExpenseIcons(db, owner).catch(() => {});
        }
        // Cosmetic failures keep a receipt or an accepted cached icon. No error banner or retry storm.
      }
    }
    timer = setTimeout(() => void read(), 250);
    return () => { stopped = true; controller.abort(); if (timer) clearTimeout(timer); };
  }, [scope]);
  if (!active || !owner) return {};
  return saved;
}
