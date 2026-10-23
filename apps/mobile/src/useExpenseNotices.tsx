import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Platform, View } from 'react-native';
import { request } from './api';
import type { Expense, Session } from './types';
import { matchesNoticePush, noticeAcknowledgments, pollExpenseNotices, readExpenseNotices, visiblyIntersects } from './expenseNotices';
import type { ExpenseNotice, NoticeFeed, NoticeSeen, WindowFrame } from './expenseNotices';
const isForeground = () => AppState.currentState === 'active' && (Platform.OS !== 'web' || document.visibilityState === 'visible');

export type NoticeVisibility = {
  notices: ExpenseNotice[]; enabled: boolean; viewport: WindowFrame | null; scrollEpoch: number;
  onVisible: (groupId: string, expenseId: string, version: number, stillVisible: () => boolean) => void;
};

export function useExpenseNotices(session: Session | null, options: { enabled: boolean; visibleExpenseIds?: string[]; onRefresh: (groupIds: string[]) => Promise<void> }) {
  const [notices, setNotices] = useState<ExpenseNotice[]>([]);
  const active = useRef({ session, ...options }); active.current = { session, ...options };
  const feed = useRef<ExpenseNotice[]>([]);
  const pending = useRef(new Map<string, { value: NoticeSeen; notice: ExpenseNotice; visible: () => boolean }>());
  const observed = useRef(new Map<string, { notice: ExpenseNotice; visible: () => boolean }>());
  const acknowledged = useRef(new Map<string, ExpenseNotice>());
  const engagement = useRef(0), scope = useRef('');
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sending = useRef(false);
  const generation = useRef(0);

  useEffect(() => { scope.current = session ? `${session.baseUrl}|${session.token}` : ''; acknowledged.current.clear(); observed.current.clear(); engagement.current = 0; }, [session?.token, session?.baseUrl]);
  useEffect(() => {
    const epoch = ++generation.current;
    feed.current = []; pending.current.clear(); setNotices([]);
    if (!session || !options.enabled) return;
    let stopped = false, polling = false;
    const current = () => !stopped && isForeground() && generation.current === epoch && active.current.enabled && active.current.session?.token === session.token && active.current.session?.baseUrl === session.baseUrl;
    const poll = async () => {
      if (polling || !current()) return;
      polling = true;
      try {
        const result = await pollExpenseNotices(() => readExpenseNotices(path => request<NoticeFeed>(session, path), active.current.visibleExpenseIds), current, ids => active.current.onRefresh(ids));
        if (result && current()) { feed.current = result.notices.filter(notice => !acknowledged.current.has(notice.id)); setNotices(feed.current); }
      } catch { /* A quiet feed failure must not interrupt a bill or claim anything seen. */ }
      finally { polling = false; }
    };
    void poll();
    const interval = setInterval(() => { void poll(); }, 10_000);
    return () => { stopped = true; clearInterval(interval); if (flushTimer.current) clearTimeout(flushTimer.current); flushTimer.current = null; pending.current.clear(); };
  }, [session?.token, session?.baseUrl, options.enabled, [...new Set(options.visibleExpenseIds ?? [])].sort().join(',')]);

  const acknowledgeVisible = useCallback((groupId: string, expenseId: string, version: number, stillVisible: () => boolean) => {
    const { session: currentSession, enabled } = active.current;
    if (!currentSession || !isForeground() || scope.current !== `${currentSession.baseUrl}|${currentSession.token}` || !enabled || !stillVisible()) return;
    for (const value of noticeAcknowledgments(feed.current, groupId, { id: expenseId, version })) {
      const notice = feed.current.find(notice => notice.id === value.id)!;
      pending.current.set(value.id, { value, notice, visible: stillVisible });
      observed.current.set(value.id, { notice, visible: stillVisible });
    }
    while (observed.current.size > 100) observed.current.delete(observed.current.keys().next().value!);
    if (!pending.current.size || flushTimer.current) return;
    const epoch = generation.current;
    const current = () => isForeground() && generation.current === epoch && active.current.enabled && active.current.session?.token === currentSession.token && active.current.session?.baseUrl === currentSession.baseUrl;
    const flush = async () => {
      flushTimer.current = null;
      if (!current()) { pending.current.clear(); return; }
      if (sending.current) { flushTimer.current = setTimeout(() => { void flush(); }, 100); return; }
      const visible = [...pending.current.values()].filter(row => row.visible()).slice(0, 50);
      const batch = visible.map(row => row.value); pending.current.clear();
      if (!batch.length) return;
      sending.current = true;
      try {
        const result = await request<{ seen: number }>(currentSession, '/me/notifications/seen', 'POST', { notices: batch });
        if (current() && result.seen === batch.length) {
          visible.forEach(row => acknowledged.current.set(row.notice.id, row.notice));
          while (acknowledged.current.size > 500) acknowledged.current.delete(acknowledged.current.keys().next().value!);
          feed.current = feed.current.filter(value => !acknowledged.current.has(value.id)); setNotices(feed.current);
        }
      } catch { /* Retried only after another actual visible render/scroll/poll. */ }
      finally { sending.current = false; }
    };
    flushTimer.current = setTimeout(() => { void flush(); }, 100);
  }, []);

  const engage = useCallback(() => {
    const { session: currentSession, enabled } = active.current;
    if (!enabled || !isForeground() || !currentSession || Date.now() - engagement.current < 300_000) return;
    engagement.current = Date.now();
    void request(currentSession, '/me/notifications/foreground', 'POST', {}).catch(() => {});
  }, []);
  const shouldSuppress = useCallback((data: unknown) => {
    const currentSession = active.current.session;
    if (!currentSession || scope.current !== `${currentSession.baseUrl}|${currentSession.token}` || !data || typeof data !== 'object') return false;
    const payload = data as Record<string, unknown>;
    if (payload.type !== 'new_bill' || payload.recipient_user_id !== currentSession.userId || typeof payload.event_id !== 'string') return false;
    const seen = acknowledged.current.get(payload.event_id);
    const row = observed.current.get(payload.event_id);
    const notice = seen ?? (row?.visible() && active.current.enabled ? row.notice : undefined);
    return !!notice && matchesNoticePush(notice, currentSession.userId, data);
  }, []);
  return { notices, acknowledgeVisible, engage, shouldSuppress };
}

/** Measurement is cancelled whenever the frame, bill revision or foreground state changes. */
export function VisibleExpense({ groupId, expense, visibility, children }: { groupId: string; expense: Pick<Expense, 'id' | 'version' | 'deleted'>; visibility?: NoticeVisibility; children: React.ReactNode }) {
  const ref = useRef<React.ComponentRef<typeof View>>(null), [layout, setLayout] = useState(0);
  const latest = useRef(visibility); latest.current = visibility;
  useEffect(() => {
    if (!visibility?.enabled || !noticeAcknowledgments(visibility.notices, groupId, expense).length) return;
    let cancelled = false;
    const frame = requestAnimationFrame(() => {
      ref.current?.measureInWindow((x, y, width, height) => {
        if (!cancelled && latest.current === visibility && visibility.enabled && visiblyIntersects({ x, y, width, height }, visibility.viewport)) visibility.onVisible(groupId, expense.id, expense.version, () => !cancelled && latest.current === visibility && visibility.enabled);
      });
    });
    return () => { cancelled = true; cancelAnimationFrame(frame); };
  }, [visibility, groupId, expense.id, expense.version, expense.deleted, layout]);
  return <View ref={ref} collapsable={false} onLayout={() => setLayout(value => value + 1)}>{children}</View>;
}
