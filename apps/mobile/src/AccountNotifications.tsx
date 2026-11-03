import { ErrorState, LoadingState } from './UIStates';
import { Dialog, DialogScrollBody } from './DialogParts';
import KeyboardDialog from './KeyboardDialog';
import React, { useEffect, useRef, useState } from 'react';
import { AppState, Platform, StyleSheet, useWindowDimensions, View } from 'react-native';
import { Text } from 'react-native-paper';
import { request, cachedRead, rememberRead, invalidateRead } from './api';
import PushSettings, { type PushControls } from './PushSettings';
import type { Session } from './types';
import { SettingsRow, useUI } from './ui';
import NotificationSwitch from './NotificationSwitch';
import BalanceStatements from './BalanceStatements';
import { createSettingWriter, type SettingState } from './settingWriter';

type Preferences = { expense_updates: boolean; email_reminders: boolean; notifications_enabled?: boolean; email_available?: boolean; push_device_ids?: string[] };
function confirmed(value: Preferences) {
  if (typeof value.expense_updates !== 'boolean' || typeof value.email_reminders !== 'boolean') throw new Error('Invalid notification preferences');
  if (value.notifications_enabled !== undefined && typeof value.notifications_enabled !== 'boolean'
    || value.email_available !== undefined && typeof value.email_available !== 'boolean'
    || value.push_device_ids !== undefined && (!Array.isArray(value.push_device_ids) || value.push_device_ids.some(id => typeof id !== 'string'))) throw new Error('Invalid notification channels');
  return value;
}
export default function AccountNotifications({ session, push, busy, onBusyChange }: { session: Session; push: PushControls; busy: boolean; onBusyChange: (value: boolean) => void }) {
  const { height } = useWindowDimensions(), { ui, palette } = useUI();
  const [open, setOpen] = useState(false), [loadError, setLoadError] = useState('');
  const [state, setState] = useState<SettingState<Preferences | null>>(() => ({ value: cachedRead<Preferences>(session, '/me/notifications/preferences') ?? null, saving: false, error: '' }));
  const row = useRef<React.ComponentRef<typeof View>>(null), mounted = useRef(true), revision = useRef(0), currentSession = useRef(session); currentSession.current = session;
  const writer = useRef<ReturnType<typeof createSettingWriter<Preferences | null>> | null>(null);
  writer.current ??= createSettingWriter(state.value, async value => {
    if (!value) throw new Error('Notifications are unavailable.');
    const active = currentSession.current;
    const saved = confirmed(await request<Preferences>(active, '/me/notifications/preferences', 'PUT', { expense_updates: value.expense_updates, email_reminders: value.email_reminders }));
    rememberRead(active, '/me/notifications/preferences', saved); return saved;
  }, value => { if (mounted.current) setState(value); }, (a, b) => a?.expense_updates === b?.expense_updates && a?.email_reminders === b?.email_reminders);
  async function load() {
    if (writer.current!.snapshot.saving || writer.current!.snapshot.error) return;
    const stamp = ++revision.current, active = currentSession.current;
    invalidateRead(active, '/me/notifications/preferences');
    try {
      const value = confirmed(await request<Preferences>(active, '/me/notifications/preferences'));
      if (mounted.current && revision.current === stamp && currentSession.current.token === active.token) { rememberRead(active, '/me/notifications/preferences', value); writer.current!.hydrate(value); setLoadError(''); }
    } catch { if (mounted.current && revision.current === stamp) setLoadError('Could not load notifications. Try again.'); }
  }
  useEffect(() => {
    mounted.current = true; void load();
    const foreground = () => { if (Platform.OS !== 'web' || document.visibilityState === 'visible') void load(); };
    const listener = AppState.addEventListener('change', value => { if (value === 'active') foreground(); });
    if (Platform.OS === 'web') document.addEventListener('visibilitychange', foreground);
    return () => { mounted.current = false; ++revision.current; listener.remove(); if (Platform.OS === 'web') document.removeEventListener('visibilitychange', foreground); };
  }, [session.token]);
  function change(patch: Partial<Preferences>) {
    const value = writer.current!.snapshot.value;
    if (busy || !value) return;
    ++revision.current; setLoadError(''); writer.current!.change({ ...value, ...patch });
  }
  const preferences = state.value, enabled = !!preferences?.expense_updates;
  function close() { setOpen(false); requestAnimationFrame(() => row.current?.focus()); }
  useEffect(() => {
    if (Platform.OS !== 'web' || !open) return;
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busy) { event.preventDefault(); event.stopPropagation(); close(); } };
    document.addEventListener('keydown', escape, true); return () => document.removeEventListener('keydown', escape, true);
  }, [open, busy]);
  return <><SettingsRow rowRef={row} icon="notifications" label="Notifications" value={preferences ? enabled ? 'On' : 'Off' : undefined} disabled={busy} onPress={() => { setOpen(true); void load(); }} />
    <KeyboardDialog label="Notifications" visible={open} dismissable={!busy} onDismiss={() => { if (!busy) close(); }}><Dialog.Title aria-level={2}>Notifications</Dialog.Title>
      <DialogScrollBody fixedHeight maxHeight={Platform.OS === 'web' ? Math.min(560, Math.max(0, height - 224)) : 440} gap={8} paddingHorizontal={16} paddingVertical={8}>
        <Text accessibilityLiveRegion="polite" style={[ui.caption, { fontSize: 12 }]}>{state.saving ? 'Saving…' : 'Changes save automatically'}</Text>
        {!!(state.error || loadError) && <ErrorState error={state.error || loadError} disabled={busy} retryLabel="Retry notifications" onRetry={() => { if (state.error) { ++revision.current; writer.current!.retry(); } else void load(); }} />}
        {preferences && <><View style={{ borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: palette.line, paddingBottom: 8 }}><NotificationSwitch icon="notifications" label="Notifications" checked={enabled} disabled={busy} onChange={expense_updates => change({ expense_updates })} /></View>
          <PushSettings push={push} busy={busy || !enabled} onBusyChange={onBusyChange} muted={!enabled} />
          <NotificationSwitch icon="mail" label="Email notifications" checked={enabled && preferences.email_reminders} disabled={busy || !enabled || preferences.email_available === false} onChange={email_reminders => { if (writer.current!.snapshot.value?.expense_updates) change({ email_reminders }); }} />
          {!enabled && <Text style={ui.caption}>Turn on notifications to choose how you receive them.</Text>}
          {enabled && !preferences.email_reminders && !(push.state.configured ?? push.state.enabled) && !push.state.working && <Text style={ui.caption}>Choose how you receive notifications below.</Text>}
          {preferences.email_available === false && <Text style={ui.caption}>Add a verified email address to receive emails.</Text>}
          <View style={{ borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.line, paddingTop: 8 }}><BalanceStatements session={session} visible={open} emailEnabled={enabled && preferences.email_reminders} notificationsEnabled={enabled} busy={busy} onBusyChange={onBusyChange} /></View>
        </>}
        {!preferences && !loadError && <LoadingState spinner label="Loading notifications…" style={{ minHeight: 180, justifyContent: 'center' }} />}
      </DialogScrollBody></KeyboardDialog>
  </>;
}
