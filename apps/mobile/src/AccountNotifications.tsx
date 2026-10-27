import { Dialog } from './DialogParts';
import { DialogScrollBody } from './DialogParts';
import KeyboardDialog from './KeyboardDialog';
import React, { useEffect, useRef, useState } from 'react';
import { AppState, Platform, useWindowDimensions, View } from 'react-native';

import { request } from './api';
import PushSettings, { type PushControls } from './PushSettings';
import type { Session } from './types';
import { Button, ErrorText, SettingsRow } from './ui';
import NotificationSwitch from './NotificationSwitch';
import BalanceStatements from './BalanceStatements';
import LoadingSpinner from './LoadingSpinner';

type Preferences = { expense_updates: boolean; email_reminders: boolean; notifications_enabled?: boolean; email_available?: boolean; push_device_ids?: string[] };
function confirmed(value: Preferences) {
  if (typeof value.expense_updates !== 'boolean' || typeof value.email_reminders !== 'boolean') throw new Error('Invalid notification preferences');
  if (value.notifications_enabled !== undefined && typeof value.notifications_enabled !== 'boolean'
    || value.email_available !== undefined && typeof value.email_available !== 'boolean'
    || value.push_device_ids !== undefined && (!Array.isArray(value.push_device_ids) || value.push_device_ids.some(id => typeof id !== 'string'))) throw new Error('Invalid notification channels');
  return value;
}
export default function AccountNotifications({ session, push, busy, onBusyChange }: { session: Session; push: PushControls; busy: boolean; onBusyChange: (value: boolean) => void }) {
  const { height } = useWindowDimensions();
  const [open, setOpen] = useState(false), [preferences, setPreferences] = useState<Preferences | null>(null), [error, setError] = useState(''), [working, setWorking] = useState(false), [pendingEnabled, setPendingEnabled] = useState<boolean | null>(null);
  const activeToken = useRef(session.token); activeToken.current = session.token;
  const row = useRef<React.ComponentRef<typeof View>>(null), mounted = useRef(true), inFlight = useRef(false), revision = useRef(0);
  async function load() {
    if (inFlight.current) return;
    const current = ++revision.current;
    try { const value = confirmed(await request<Preferences>(session, '/me/notifications/preferences')); if (mounted.current && current === revision.current) { setPreferences(value); setError(''); } }
    catch { if (mounted.current && current === revision.current) setError('Could not load notifications. Try again.'); }
  }
  useEffect(() => {
    mounted.current = true; if (!push.state.working) void load();
    const foreground = () => { if (Platform.OS !== 'web' || document.visibilityState === 'visible') void load(); };
    const listener = AppState.addEventListener('change', value => { if (value === 'active') foreground(); });
    if (Platform.OS === 'web') document.addEventListener('visibilitychange', foreground);
    return () => { mounted.current = false; listener.remove(); if (Platform.OS === 'web') document.removeEventListener('visibilitychange', foreground); };
  }, [session.token, push.state.enabled, push.state.working]);
  async function update(value: Preferences, enablePush = false) {
    if (busy || inFlight.current) return;
    inFlight.current = true; ++revision.current; setWorking(true); setPendingEnabled(enabled); setError(''); onBusyChange(true);
    try {
      let saved = confirmed(await request<Preferences>(session, '/me/notifications/preferences', 'PUT', { expense_updates: value.expense_updates, email_reminders: value.email_reminders }));
      if (!mounted.current || activeToken.current !== session.token) return;
      if (enablePush && Platform.OS !== 'web' && (!push.state.enabled || saved.push_device_ids && !saved.push_device_ids.includes(push.state.installationId ?? ''))) {
        try { if (await push.enable()) saved = confirmed(await request<Preferences>(session, '/me/notifications/preferences')); }
        catch { if (mounted.current) setError('Email is on. Could not enable push notifications.'); }
      }
      if (mounted.current && activeToken.current === session.token) setPreferences(saved);
    }
    catch { if (mounted.current) setError('Could not save notifications. Try again.'); }
    finally { inFlight.current = false; if (mounted.current) { setWorking(false); setPendingEnabled(null); } onBusyChange(false); }
  }
  const emailAvailable = !!preferences?.email_reminders && preferences.email_available !== false;
  const currentPushEnabled = push.state.enabled && (!preferences?.push_device_ids || preferences.push_device_ids.includes(push.state.installationId ?? ''));
  const pushAvailable = preferences?.push_device_ids ? preferences.push_device_ids.some(id => Platform.OS === 'web' || push.state.ready && (id !== push.state.installationId || push.state.enabled)) : push.state.enabled;
  const enabled = pendingEnabled ?? (!!preferences?.expense_updates && preferences.notifications_enabled !== false && (emailAvailable || pushAvailable));
  const disabled = busy || working || push.state.working || !preferences;
  const value = !preferences ? 'Unavailable' : !enabled ? 'Off' : pushAvailable ? emailAvailable ? 'Push and email' : 'Push' : 'Email only';
  function close() { setOpen(false); requestAnimationFrame(() => row.current?.focus()); }
  useEffect(() => {
    if (Platform.OS !== 'web' || !open) return;
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busy && !working) { event.preventDefault(); event.stopPropagation(); close(); } };
    document.addEventListener('keydown', escape, true);
    return () => document.removeEventListener('keydown', escape, true);
  }, [open, busy, working]);
  return <><SettingsRow rowRef={row} icon="notifications" label="Notifications" value={value} disabled={busy} onPress={() => { setOpen(true); void load(); }} />
    <KeyboardDialog visible={open} dismissable={!busy && !working} onDismiss={() => { if (!busy && !working) close(); }}><Dialog.Title aria-level={2}>Notifications</Dialog.Title>
      <DialogScrollBody maxHeight={Platform.OS === 'web' ? Math.min(560, Math.max(0, height - 224)) : 440} gap={12}>
        {preferences && <><NotificationSwitch icon="notifications" label="Notifications" checked={enabled} disabled={!!disabled} onChange={expense_updates => void update({ ...preferences, expense_updates, email_reminders: expense_updates ? true : preferences.email_reminders }, expense_updates)} />
            {enabled && <><PushSettings push={{ ...push, state: { ...push.state, enabled: currentPushEnabled } }} busy={!!disabled} onBusyChange={onBusyChange} onChanged={async enabled => { await update({ ...preferences, expense_updates: enabled || emailAvailable }); }} />
            <NotificationSwitch icon="mail" label="Email notifications" checked={preferences.email_reminders} disabled={!!disabled} onChange={email_reminders => void update({ ...preferences, expense_updates: email_reminders || currentPushEnabled, email_reminders })} />
            {open && enabled && <BalanceStatements session={session} visible={open} emailEnabled={preferences.email_reminders} busy={!!disabled} onBusyChange={onBusyChange} />}
            </>}
        </>}
        {!!error && <><ErrorText>{error}</ErrorText>{!preferences && <Button title="Retry" disabled={busy || working} onPress={() => void load()} />}</>}
      </DialogScrollBody><Dialog.Actions><View style={{ width: 20, height: 20, alignItems: 'center', justifyContent: 'center' }}><LoadingSpinner visible={working} /></View><Button title="Done" kind="text" disabled={busy || working} onPress={close} /></Dialog.Actions></KeyboardDialog>
  </>;
}
