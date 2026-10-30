import { useLoading } from './LoadingOverlay';
import React, { useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { request } from './api';
import type { Session } from './types';
import { SectionHeading, Button, SettingsRow, useUI } from './ui';

type Conversation = { group_id: string; expense_id: string; group: string; bill: string; unread: number };
type Inbox = { conversations: Conversation[]; next_cursor: string | null };
export default function ChatInbox({ session, active, busy, onOpen, onEmptyChange }: { session: Session; active: boolean; busy: boolean; onOpen: (group: string, bill: string) => void; onEmptyChange?: (empty: boolean) => void }) {
  const { ui } = useUI(), [before, setBefore] = useState<string | null>(null), [error, setError] = useState('');
  const scope = JSON.stringify([session.baseUrl, session.userId, session.token, before]);
  const [saved, setSaved] = useState<{ scope: string; page: Inbox } | null>(null);
  const page = saved?.scope === scope ? saved.page : null;
  const emptyHandler = useRef(onEmptyChange); emptyHandler.current = onEmptyChange;
  useLoading(active && !page && !error);
  useEffect(() => {
    setError('');
    if (!active) { emptyHandler.current?.(false); return; }
    let stopped = false, failures = 0, controller: AbortController, timer: ReturnType<typeof setTimeout>;
    async function read() {
      emptyHandler.current?.(false);
      controller = new AbortController();
      try {
        const result = await request<Inbox>(session, '/me/chat-conversations?limit=20' + (before ? `&before=${encodeURIComponent(before)}` : ''), 'GET', undefined, 'json', controller.signal);
        if (!stopped) { setSaved({ scope, page: result }); setError(''); failures = 0; emptyHandler.current?.(!before && !result.conversations.length && !result.next_cursor); }
      } catch { if (!stopped) { emptyHandler.current?.(false); setError('Could not refresh unread chats.'); failures = Math.min(failures + 1, 2); } }
      finally { if (!stopped) timer = setTimeout(() => void read(), Math.min(60_000, 15_000 * 2 ** failures)); }
    }
    void read(); return () => { stopped = true; clearTimeout(timer); controller?.abort(); emptyHandler.current?.(false); };
  }, [session.baseUrl, session.userId, session.token, active, before]);
  if (!page?.conversations.length && !error && !before) return null;
  return <View role="region" accessibilityLabel="Unread chats" style={{ gap: 8 }}>
    <View style={{ gap: 8 }}>
    <SectionHeading>Unread chats</SectionHeading>
    <View>{page?.conversations.map(row => <SettingsRow key={`${row.group_id}|${row.expense_id}`} icon="people" label={`${row.bill} · ${row.group}`} value={`${row.unread} unread`} disabled={busy || !active} onPress={() => onOpen(row.group_id, row.expense_id)} />)}</View>
    {before && <Button title="Latest chats" kind="text" disabled={busy || !active} onPress={() => setBefore(null)} />}
    {page?.next_cursor && <Button title="Older chats" kind="text" disabled={busy || !active} onPress={() => setBefore(page.next_cursor)} />}
    {!!error && <Text style={ui.caption}>{error}</Text>}
    </View>
  </View>;
}
