import ChatLoadingState from './ChatLoadingState';
import BottomSafeArea from './BottomSafeArea';
import { Dialog } from './DialogParts';
import { useScrollPagination } from './useScrollPagination';
import { APP_ORIGIN } from './appLinks';
import React, { useEffect, useRef, useState } from 'react';
import { FlatList, KeyboardAvoidingView, Linking, Platform, ScrollView, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import * as Crypto from 'expo-crypto';
import { accountOwner, ApiError, request } from './api';
import { changeChatWork, chatMessageRows, chatPath, editRejectedChat, mergeChatMessages, queueChatMessage, readChatWork, sendChatMessage, startChatReads, visibleChatTokens } from './billChat';
import type { ChatDisplayMessage, ChatMessage, ChatPage, ChatWork } from './billChat';
import ChatControls, { ChatMenu } from './ChatControls';
import ChatComposerSurface from './ChatComposerSurface';
import MotionReveal from './MotionReveal';
import KeyboardDialog from './KeyboardDialog';
import { getDatabase, storageIsDurable } from './native';
import type { Session } from './types';
import { Button, Icon, IconAction, SettingsRow, useUI } from './ui';

export function BillChatEntry({ session, groupId, expenseId, active, disabled, onOpen }: { session: Session; groupId: string; expenseId: string; active: boolean; disabled: boolean; onOpen: () => void }) {
  const [unread, setUnread] = useState<number | null>(null), path = chatPath(groupId, expenseId);
  useEffect(() => {
    setUnread(null); if (!active) return;
    let stopped = false, timer: ReturnType<typeof setTimeout>, controller: AbortController;
    async function read() {
      controller = new AbortController();
      try { const value = await request<{ unread: number }>(session, path + '/status', 'GET', undefined, 'json', controller.signal); if (!stopped) setUnread(value.unread); }
      catch { /* Unread is unknown while offline; never mark it as zero. */ }
      finally { if (!stopped) timer = setTimeout(() => void read(), 15_000); }
    }
    void read(); return () => { stopped = true; clearTimeout(timer); controller?.abort(); };
  }, [session.baseUrl, session.userId, session.token, path, active]);
  return <SettingsRow label="Chat" icon="people" value={unread ? `${unread} unread` : undefined} disabled={disabled} onPress={onOpen} />;
}
function ChatMessageArrival({ pending, children, style }: { pending: boolean; children: React.ReactNode; style: import('react-native').StyleProp<import('react-native').ViewStyle> }) {
  const animate = useRef(pending).current, Surface = animate ? MotionReveal : View;
  return <Surface style={style}>{children}</Surface>;
}
export function ChatMessageRow({ message, own, showDate, active, onReport, onBlock, sending = false, online = true, onRetry }: { message: ChatDisplayMessage; own: boolean; showDate: boolean; active: boolean; sending?: boolean; online?: boolean; onRetry?: () => void; onReport: (kind: 'message' | 'user') => void; onBlock: () => void }) {
  const { ui, palette } = useUI(), date = new Date(message.created_at), pending = message.pending;
  const failed = !!pending?.error && !sending && (online || !!pending.rejected), waiting = !!pending && !sending;
  const status = !pending ? 'Sent' : sending ? 'Sending' : pending.rejected ? 'Not sent' : !online ? 'Waiting for connection' : failed ? 'Not confirmed' : 'Waiting to send';
  return <ChatMessageArrival pending={!!pending} style={{ gap: 4, paddingVertical: 8 }}>
    {showDate && Number.isFinite(date.getTime()) && <Text style={[ui.caption, { textAlign: 'center', paddingVertical: 12 }]}>{date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}</Text>}
    <View style={{ flexDirection: 'row', justifyContent: own ? 'flex-end' : 'flex-start', alignItems: 'flex-end', gap: 6 }}>
      {!own && <View accessible={false} style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: palette.soft, alignItems: 'center', justifyContent: 'center' }}><Text style={[ui.caption, { color: palette.text }]}>{message.sender.trim().split(/\s+/).map(word => word[0]).slice(0, 2).join('')}</Text></View>}
      <View style={{ maxWidth: '78%', flexShrink: 1, gap: 5 }}>
        {!own && <Text style={ui.caption}>{message.sender}</Text>}
        <View style={{ alignSelf: own ? 'flex-end' : 'flex-start', maxWidth: '100%', paddingHorizontal: 14, paddingVertical: 10, borderRadius: 18, borderBottomRightRadius: own ? 5 : 18, borderBottomLeftRadius: own ? 18 : 5, backgroundColor: own ? palette.accent : palette.soft }}>
          <Text selectable style={[ui.body, own && { color: palette.background }]}>{message.text}</Text>
        </View>
        <View style={{ flexDirection: 'row', justifyContent: own ? 'flex-end' : 'flex-start', alignItems: 'center', flexWrap: 'wrap', gap: 5, minHeight: 20 }}>
          {Number.isFinite(date.getTime()) && <Text style={[ui.caption, { fontSize: 12 }]}>{date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</Text>}
          {own && <View accessible accessibilityLabel={status} accessibilityHint={failed ? pending?.error : undefined} accessibilityLiveRegion="polite"><Icon name={pending ? failed ? 'info' : 'history' : 'check'} size={14} color={failed ? palette.error : palette.muted} /></View>}
          {pending && (failed || waiting) && <Text style={[ui.caption, { fontSize: 12, color: failed ? palette.error : palette.muted }]}>{status}</Text>}
          {pending && !sending && failed && <Button title={pending.rejected ? 'Edit message' : 'Retry'} kind="text" disabled={!active || (!pending.rejected && !online)} onPress={onRetry} hitSlop={6} style={{ minHeight: 32, paddingHorizontal: 4 }} />}
        </View>
        {failed && pending?.rejected && pending.error && <Text accessibilityRole="alert" style={[ui.caption, { color: palette.error }]}>{pending.error}</Text>}
      </View>
      {!own && <ChatMenu own={own} disabled={!active} onReport={onReport} onBlock={onBlock} />}
    </View>
  </ChatMessageArrival>;
}
export function ChatComposer({ text, disabled, sendDisabled, onChange, onSend }: { text: string; disabled: boolean; sendDisabled?: boolean; onChange: (text: string) => void; onSend: () => void }) {
  const { ui, palette, inputColors } = useUI(), { fontScale = 1 } = useWindowDimensions();
  const [expanded, setExpanded] = useState(false);
  return <ChatComposerSurface style={{ flexDirection: 'row', alignItems: expanded ? 'flex-end' : 'center', gap: 4, padding: 4, borderRadius: expanded ? 18 : 28, borderWidth: 1, borderColor: palette.line }}>
    <TextInput {...inputColors} accessibilityLabel="Message" placeholder="Message…" placeholderTextColor={palette.muted}
      multiline onLayout={event => setExpanded(event.nativeEvent.layout.height > (ui.body?.lineHeight ?? 23) * fontScale + 25)} maxLength={2000} value={text} onChangeText={onChange} editable={!disabled} underlineColorAndroid="transparent"
      style={[ui.body, { flex: 1, minWidth: 0, minHeight: 44, maxHeight: 144, paddingHorizontal: 14, paddingTop: 10, paddingBottom: 10, backgroundColor: 'transparent', textAlignVertical: 'top' }]} />
    <Button iconOnly icon={({ color }) => <Icon name="send" size={22} color={color} />}
      accessibilityLabel="Send message" kind="primary" disabled={disabled || sendDisabled || !text.trim()} onPress={onSend}
      hitSlop={0} style={{ width: 44, height: 44, borderRadius: 22 }} />
  </ChatComposerSurface>;
}
export function ChatEmptyState({ onSuggest, disabled }: { onSuggest: (text: string) => void; disabled: boolean }) {
  const { ui, palette } = useUI();
  return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12 }}>
    <Icon name="feedback" size={40} color={palette.accent} />
    <Text style={[ui.body, { fontSize: 20, fontWeight: '600', textAlign: 'center' }]}>Talk about this bill</Text>
    <Text style={[ui.caption, { textAlign: 'center' }]}>Ask a question or clarify a split.</Text>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 8, marginTop: 8 }}>
      {['Check my share', 'What’s included?'].map(text => <Button key={text} title={text} kind="outlined" disabled={disabled} onPress={() => onSuggest(text === 'Check my share' ? 'Can you confirm my share?' : 'What’s included in this bill?')} style={{ minHeight: 44, borderRadius: 22 }} />)}
    </View>
  </View>;
}

export default function BillChatScreen({ session, groupId, expenseId, active, online, onRead, onUnsentChange, billTitle, billAmount, onOpenBill }: { billTitle?: string; billAmount?: string; onOpenBill?: () => void; session: Session; groupId: string; expenseId: string; active: boolean; online: boolean; onRead?: () => void; onUnsentChange?: (unsent: boolean) => void }) {
  const { ui, palette, motion } = useUI(), { height } = useWindowDimensions(), path = chatPath(groupId, expenseId), insets = useSafeAreaInsets();
  const [messages, setMessages] = useState<ChatMessage[]>([]), [page, setPage] = useState<ChatPage | null>(null), [work, setWork] = useState<ChatWork>({ draft: '', pending: [] });
  const [reconnected, setReconnected] = useState(0), [ready, setReady] = useState(false), [error, setError] = useState(''), [sending, setSending] = useState('');
  const [visible, setVisible] = useState<string[]>([]), [policy, setPolicy] = useState(false), [working, setWorking] = useState(false);
  const [report, setReport] = useState<{ message: ChatMessage; kind: 'message' | 'user' } | null>(null), [settings, setSettings] = useState(false), [newMessages, setNewMessages] = useState(false), [denied, setDenied] = useState(false);
  const list = useRef<FlatList<ChatDisplayMessage>>(null), rows = useRef(messages), viewable = useRef(visible), follow = useRef(true), incoming = useRef<ChatMessage[]>([]), forceFollow = useRef(false), alive = useRef(true), draft = useRef(''), laidOutMessages = useRef(false);
  const scope = `${accountOwner(session)}|${session.token}|${path}`, currentScope = useRef(scope); currentScope.current = scope;
  rows.current = messages; viewable.current = visible;
  const ackVisible = useRef<() => void>(() => {}), readFailed = useRef(false), reads = useRef<ReturnType<typeof startChatReads> | null>(null), sendingLock = useRef(false), composingLock = useRef(false), controlLock = useRef(false), acked = useRef(new Set<string>());
  const current = () => alive.current && currentScope.current === scope;
  const enabled = active && online && !denied, durable = storageIsDurable();
  const hasUnsent = !!work.draft || work.pending.length > 0, temporaryUnsent = !durable && hasUnsent;
  const unsentHandler = useRef(onUnsentChange); unsentHandler.current = onUnsentChange;
  useEffect(() => { if (ready) unsentHandler.current?.(hasUnsent); }, [ready, hasUnsent]);
  useEffect(() => {
    if (Platform.OS !== 'web' || !temporaryUnsent) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [temporaryUnsent]);
  const viewability = useRef({ minimumViewTime: 500, viewAreaCoveragePercentThreshold: 50 });
  const onViewable = useRef(({ viewableItems }: { viewableItems: { isViewable: boolean; item: ChatDisplayMessage }[] }) => setVisible(viewableItems.filter(row => row.isViewable && !row.item.pending).map(row => row.item.id)));
  useEffect(() => {
    alive.current = true;
    void getDatabase().then(db => readChatWork(db, session, path)).then(value => { if (current()) { draft.current = value.draft; setWork(value); setReady(true); } }).catch(() => { if (current()) setError('Could not load saved messages. Reopen this chat to retry.'); });
    return () => { alive.current = false; };
  }, []);
  useEffect(() => {
    if (!enabled) return;
    reads.current = startChatReads(session, path, () => [...viewable.current, ...incoming.current.map(row => row.id)].slice(0, 50), (value, older) => {
      if (readFailed.current) { readFailed.current = false; setReconnected(value => value + 1); }
      ackVisible.current();
      setError(''); setPage(previous => older && previous ? { ...value, after_cursor: previous.after_cursor } : value);
      const unseen = value.messages.some(row => !rows.current.some(old => old.id === row.id));
      if (!older && unseen && rows.current.length && !follow.current) {
        incoming.current = mergeChatMessages(incoming.current, value.messages.filter(row => !rows.current.some(old => old.id === row.id)), value.removed_ids);
        setNewMessages(true);
        setMessages(previous => mergeChatMessages(previous, value.messages.filter(row => previous.some(old => old.id === row.id)), value.removed_ids));
      } else {
        const waiting = incoming.current; incoming.current = [];
        setMessages(previous => mergeChatMessages(previous, [...waiting, ...value.messages], value.removed_ids));
      }
    }, cause => {
      readFailed.current = true;
      setError(cause instanceof Error ? cause.message : 'Could not refresh messages.');
      if (cause instanceof ApiError && [401, 403, 404].includes(cause.status)) { setDenied(true); setMessages([]); setPage(null); }
    });
    return () => { reads.current?.stop(); reads.current = null; };
  }, [enabled, session.token, path]);
  useEffect(() => {
    if (!enabled) return;
    let controller: AbortController | undefined, running = false, cancelled = false;
    function acknowledge() {
      if (cancelled || running || !current()) return;
      const unseen = viewable.current.filter(id => !acked.current.has(id));
      const tokens = visibleChatTokens(rows.current, unseen, active);
      if (!tokens.length) return;
      controller = new AbortController(); running = true;
      void request(session, path + '/seen', 'POST', { tokens }, 'json', controller.signal).then(() => {
        if (cancelled || !current()) return;
        unseen.forEach(id => acked.current.add(id)); onRead?.();
      }).catch(() => { /* The next successful foreground read retries current visible IDs. */ }).finally(() => { running = false; });
    }
    ackVisible.current = acknowledge; acknowledge();
    return () => { cancelled = true; controller?.abort(); if (ackVisible.current === acknowledge) ackVisible.current = () => {}; };
  }, [enabled, visible.join(',')]);
  function typed(text: string) {
    draft.current = text; setWork(previous => ({ ...previous, draft: text }));
    void getDatabase().then(db => changeChatWork(db, session, path, value => ({ ...value, draft: text }))).catch(() => { if (current()) setError('Could not save this draft. Keep this chat open and retry.'); });
  }
  async function reloadWork() { const value = await readChatWork(await getDatabase(), session, path); if (current()) setWork({ ...value, draft: draft.current }); }
  async function retry(id: string) {
    if (sendingLock.current || !enabled || !page?.can_send) return;
    sendingLock.current = true; setSending(id); setError('');
    try {
      const row = await sendChatMessage(await getDatabase(), session, path, id);
      if (current()) { const waiting = incoming.current; incoming.current = []; forceFollow.current = true; follow.current = true; setNewMessages(false); setMessages(previous => mergeChatMessages(previous, [...waiting, row])); reads.current?.refresh(); }
    } catch (cause) { if (current()) setError(cause instanceof Error ? cause.message : 'Could not confirm the message. Retry it.'); }
    finally { sendingLock.current = false; if (current()) { setSending(''); await reloadWork(); } }
  }
  async function send(policyAccepted = false) {
    if (!ready || composingLock.current || sendingLock.current || !page?.can_send || !active) return;
    if (!policyAccepted && !page.policy_accepted) { setPolicy(true); return; }
    composingLock.current = true;
    const text = draft.current, id = Crypto.randomUUID();
    try {
      await queueChatMessage(await getDatabase(), session, path, id, text);
      if (!current()) return;
      if (draft.current === text) draft.current = '';
      follow.current = true; forceFollow.current = true; setNewMessages(false); await reloadWork();
      await retry(id);
    } catch (cause) { if (current()) setError(cause instanceof Error ? cause.message : 'Could not save the message.'); }
    finally { composingLock.current = false; }
  }
  async function control(action: () => Promise<void>) {
    if (controlLock.current || !enabled) return;
    controlLock.current = true; setWorking(true); setError('');
    try { await action(); reads.current?.refresh(); }
    catch (cause) { if (current()) setError(cause instanceof Error ? cause.message : 'Could not update chat.'); }
    finally { controlLock.current = false; if (current()) setWorking(false); }
  }
  async function block(id: string, blocked: boolean) {
    await request(session, path + '/block', 'PUT', { user_id: Number(id), blocked });
    reads.current?.refresh(true);
    if (blocked) incoming.current = incoming.current.filter(row => row.sender_id !== id);
    if (blocked && current()) setMessages(previous => previous.filter(row => row.sender_id !== id));
    if (current()) setPage(previous => previous ? { ...previous, blocked_users: blocked ? [...previous.blocked_users, { id, name: rows.current.find(row => row.sender_id === id)?.sender ?? 'Participant' }] : previous.blocked_users.filter(row => row.id !== id) } : previous);
  }
  // Retry durable pending work on foreground/reconnect, never on every poll.
  useEffect(() => {
    let cancelled = false;
    if (ready && enabled && page?.can_send) void (async () => {
      const saved = await readChatWork(await getDatabase(), session, path);
      for (const row of saved.pending) {
        if (cancelled || !current() || row.rejected) break;
        await retry(row.id);
        const updated = await readChatWork(await getDatabase(), session, path);
        if (updated.pending.some(value => value.id === row.id)) break;
      }
    })().catch(() => {});
    return () => { cancelled = true; };
  }, [ready, enabled, page?.can_send, reconnected]);
  function showNew() {
    const waiting = incoming.current; incoming.current = []; follow.current = true; forceFollow.current = true; setNewMessages(false);
    setMessages(previous => mergeChatMessages(previous, waiting)); list.current?.scrollToOffset({ offset: 0, animated: motion.enabled });
  }
  const paging = useScrollPagination({ scope, cursor: page?.older_cursor, enabled, load: async signal => {
    follow.current = false; forceFollow.current = false;
    const before = new Set(rows.current.map(row => row.id));
    const value = await reads.current?.older(signal);
    return value ? value.messages.some(row => !before.has(row.id)) : null;
  } });
  const newestFirst = chatMessageRows(messages, work.pending, session.userId);
  const Viewport = Platform.OS === 'android' ? KeyboardAvoidingView : View;
  return <Viewport role="main" {...(Platform.OS === 'android' ? { behavior: 'height' as const, keyboardVerticalOffset: insets.top } : {})} style={{ flex: 1, width: '100%', maxWidth: 760, alignSelf: 'center' }}>
    <View style={{ flexDirection: 'row', paddingHorizontal: 16, alignItems: 'center' }}><Button kind="plain" accessibilityLabel={`View bill, ${billTitle ?? 'Bill'}${billAmount ? `, ${billAmount}` : ''}`} disabled={!onOpenBill} onPress={onOpenBill} style={{ flex: 1, minWidth: 0, minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
      <Icon name="bill" size={20} color={palette.muted} /><Text numberOfLines={1} style={[ui.body, { flex: 1, fontWeight: '500' }]}>{billTitle ?? 'Bill'}</Text>{billAmount && <Text style={ui.caption}>{billAmount}</Text>}{onOpenBill && <Icon name="next" size={16} color={palette.muted} />}
    </Button><IconAction name="settings" label="Chat settings" disabled={!active} onPress={() => setSettings(true)} /></View>
    <FlatList ref={list} inverted={newestFirst.length > 0} data={newestFirst} keyExtractor={row => row.sender_id === session.userId ? `own:${row.client_id}` : row.id} style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 12, ...(!newestFirst.length ? { flexGrow: 1 } : {}) }}
      maintainVisibleContentPosition={{ minIndexForVisible: 0 }} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag"
      onViewableItemsChanged={onViewable.current} viewabilityConfig={viewability.current}
      onScrollBeginDrag={() => { forceFollow.current = false; follow.current = false; }}
      onScroll={event => { const { contentOffset } = event.nativeEvent; const atBottom = contentOffset.y < 80; if (atBottom) { forceFollow.current = false; follow.current = true; setNewMessages(false); if (incoming.current.length) showNew(); } else if (!forceFollow.current) follow.current = false; }} scrollEventThrottle={100}
      onContentSizeChange={(width, height) => { if ((follow.current || forceFollow.current) && !paging.loading) { forceFollow.current = true; list.current?.scrollToOffset({ offset: 0, animated: motion.enabled && laidOutMessages.current }); } if (newestFirst.length) laidOutMessages.current = true; }}
      ListFooterComponent={messages.length ? <View style={{ paddingVertical: 12 }}>{paging.canLoadMore && !paging.failed && <Button title={paging.loading ? 'Loading…' : 'Load older'} style={{ minWidth: 120 }} kind="text" disabled={paging.loading} onPress={paging.loadMore} />}{paging.failed && <Button title="Retry" kind="text" disabled={!enabled} onPress={paging.retry} />}</View> : undefined}
      ListEmptyComponent={<View style={{ flex: 1 }}>{!page && !error && enabled ? <ChatLoadingState /> : page && <ChatEmptyState disabled={!ready || !active || denied || !page.can_send || !!work.draft} onSuggest={typed} />}</View>}
      renderItem={({ item, index }) => <ChatMessageRow message={item} own={item.sender_id === session.userId} active={item.pending?.rejected ? active : enabled} showDate={index === newestFirst.length - 1 || new Date(newestFirst[index + 1].created_at).toDateString() !== new Date(item.created_at).toDateString()} onReport={kind => setReport({ message: item, kind })} onBlock={() => void control(() => block(item.sender_id, true))}
        sending={sending === item.client_id} online={online} onRetry={() => {
          if (item.pending?.rejected) void getDatabase().then(db => editRejectedChat(db, session, path, item.client_id)).then(value => { if (current()) { draft.current = value.draft; setWork(value); } }).catch(cause => setError(cause.message));
          else void retry(item.client_id);
        }} />} />
    {newMessages && <Button title="New messages" kind="text" onPress={showNew} />}
    <BottomSafeArea style={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 8, gap: 8 }}>

      {!!error && !work.pending.some(row => row.error === error) && <Text accessibilityRole="alert" style={ui.error}>{error}</Text>}
      {temporaryUnsent && <Text accessibilityLiveRegion="polite" style={ui.caption}>Unsent text lasts only in this tab.</Text>}
      {!online && <Text style={ui.caption}>{durable ? 'Offline. Your draft stays here.' : 'Offline. Retry when connected.'}</Text>}
      {page && !page.can_send ? <Text style={ui.caption}>This conversation is read-only.</Text> : <ChatComposer text={work.draft} disabled={!ready || !active || denied} sendDisabled={!page?.can_send || !!sending} onChange={typed} onSend={() => void send()} />}
      {denied && <Text style={ui.caption}>This conversation is unavailable. Your unsent text is saved.</Text>}
    </BottomSafeArea>
    <KeyboardDialog visible={policy} onDismiss={() => setPolicy(false)} dismissable={!working} maxHeight={height * 0.85}>
      <Dialog.Title aria-level={2}>Before your first message</Dialog.Title><ScrollView style={{ flexShrink: 1, paddingHorizontal: 24 }}><Text style={ui.body}>Group members can read this chat. Only people included in this bill get notifications. Keep chat respectful. No harassment, threats, illegal or sexual content. You can report messages and block chat users. Agree to send this message.</Text><Button title="Read chat policy" kind="text" onPress={() => void Linking.openURL(APP_ORIGIN + '/chat-policy')} /></ScrollView>
      <Dialog.Actions><View style={{ flex: 1, gap: 8 }}><Button title="Agree" kind="primary" disabled={working || !online} onPress={() => void control(async () => { await request(session, '/me/chat-policy', 'PUT', { version: page?.policy_version ?? 1 }); if (current()) { setPage(previous => previous ? { ...previous, policy_accepted: true } : previous); setPolicy(false); await send(true); } })} /><Button title="Cancel" kind="text" disabled={working} onPress={() => setPolicy(false)} /></View></Dialog.Actions>
    </KeyboardDialog>
    <ChatControls key={report?.message.id ?? 'settings'} report={report} blocked={settings ? page?.blocked_users ?? [] : null} policyUrl={APP_ORIGIN + '/chat-policy'} busy={working} error={error} onClose={() => { setReport(null); setSettings(false); }} onReport={reason => void control(async () => { if (!report) return; await request(session, path + '/report', 'POST', { message_id: report.message.id, kind: report.kind, reason }); if (current()) setReport(null); })} onUnblock={id => void control(() => block(id, false))} />
  </Viewport>;
}
