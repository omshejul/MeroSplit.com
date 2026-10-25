import { useEffect, useRef, useState } from 'react';
import { accountOwner, ApiError, request } from './api';
import { categoryKey, categoryIcon } from './categoryIcons';
import type { ExpenseIconRef, ExpenseIcons } from './categoryIcons';
import type { Session } from './types';

type Hint = { id: string; group_id: string; title: string; category: string | null; state: string };
const pendingDelays = [5_000, 15_000, 30_000];

export function useExpenseIcons(session: Session | null, visible: ExpenseIconRef[], active: boolean, online: boolean): ExpenseIcons {
  const refs = [...new Map(visible.map(ref => [ref.id, ref])).values()].sort((a, b) => a.id.localeCompare(b.id)).slice(0, 20);
  const account = session ? `${accountOwner(session)}|${session.token}` : '';
  const query = JSON.stringify(refs), scope = `${account}|${active}|${online}|${query}`;
  const current = useRef(scope); current.current = scope;
  const [saved, setSaved] = useState<{ account: string; icons: ExpenseIcons }>({ account: '', icons: {} });
  useEffect(() => {
    if (!session || !active || !online || !refs.length) return;
    let stopped = false, timer: ReturnType<typeof setTimeout> | undefined, attempt = 0;
    const controller = new AbortController();
    const valid = () => !stopped && !controller.signal.aborted && current.current === scope;
    async function read() {
      try {
        const result = await request<{ items: Hint[] }>(session!, `/expense-icons?ids=${encodeURIComponent(refs.map(ref => ref.id).join(','))}`, 'GET', undefined, 'json', controller.signal);
        if (!valid() || !Array.isArray(result.items)) return;
        let pending = false;
        const values: ExpenseIcons = {};
        for (const ref of refs) {
          const hint = result.items.find(row => row.id === ref.id && row.group_id === ref.groupId && row.title === ref.title);
          if (!hint) continue;
          pending ||= hint.state === 'pending';
          if (['ready', 'manual'].includes(hint.state) && hint.category && (categoryIcon(hint.category) !== 'bill' || hint.category === 'general')) values[categoryKey(ref.groupId, ref.id, ref.title)] = hint.category;
        }
        setSaved(previous => {
          const icons = previous.account === account ? { ...previous.icons } : {};
          refs.forEach(ref => delete icons[categoryKey(ref.groupId, ref.id, ref.title)]);
          return { account, icons: Object.fromEntries(Object.entries({ ...icons, ...values }).slice(-200)) };
        });
        if (pending && attempt < pendingDelays.length) timer = setTimeout(() => void read(), pendingDelays[attempt++]);
      } catch (cause) {
        if (valid() && cause instanceof ApiError && [401, 403, 404].includes(cause.status)) setSaved({ account, icons: {} });
        // Cosmetic failures keep a receipt or an accepted cached icon. No error banner or retry storm.
      }
    }
    void read();
    return () => { stopped = true; controller.abort(); if (timer) clearTimeout(timer); };
  }, [scope]);
  if (!active || saved.account !== account) return {};
  return Object.fromEntries(refs.map(ref => categoryKey(ref.groupId, ref.id, ref.title)).filter(key => Object.hasOwn(saved.icons, key)).map(key => [key, saved.icons[key]]));
}
