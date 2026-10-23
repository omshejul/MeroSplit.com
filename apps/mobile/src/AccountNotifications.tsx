import React, { useEffect, useRef, useState } from 'react';
import { AppState, Platform, ScrollView, View } from 'react-native';
import { Dialog, Portal, Switch, Text } from 'react-native-paper';
import { request } from './api';
import PushSettings, { type PushControls } from './PushSettings';
import type { Session } from './types';
import { Button, ErrorText, SettingsRow, useUI } from './ui';

type Preferences = { expense_updates: boolean; email_reminders: boolean };
function NotificationSwitch({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled: boolean; onChange: (value: boolean) => void }) {
  const { ui, palette } = useUI();
  return <View style={{ flexDirection: 'row', alignItems: 'center', minHeight: 48, gap: 12 }}>
    <Text style={[ui.body, { flex: 1 }]}>{label}</Text>
    <Switch accessibilityLabel={label} value={checked} disabled={disabled} trackColor={{ false: palette.outline, true: disabled ? palette.outline : '#007AFF' }} thumbColor="#FFFFFF" ios_backgroundColor={palette.outline} onValueChange={onChange} />
  </View>;
}
export default function AccountNotifications({ session, push, busy, onBusyChange }: { session: Session; push: PushControls; busy: boolean; onBusyChange: (value: boolean) => void }) {
  const { ui } = useUI();
  const [open, setOpen] = useState(false), [preferences, setPreferences] = useState<Preferences | null>(null), [error, setError] = useState(''), [working, setWorking] = useState(false);
  const row = useRef<React.ComponentRef<typeof View>>(null), mounted = useRef(true), inFlight = useRef(false), revision = useRef(0);
  async function load() {
    if (inFlight.current) return;
    const current = ++revision.current;
    try { const value = await request<Preferences>(session, '/me/notifications/preferences'); if (mounted.current && current === revision.current) { setPreferences(value); setError(''); } }
    catch { if (mounted.current && current === revision.current) setError('Could not load notifications. Try again.'); }
  }
  useEffect(() => {
    mounted.current = true; void load();
    const foreground = () => { if (Platform.OS !== 'web' || document.visibilityState === 'visible') void load(); };
    const listener = AppState.addEventListener('change', value => { if (value === 'active') foreground(); });
    if (Platform.OS === 'web') document.addEventListener('visibilitychange', foreground);
    return () => { mounted.current = false; listener.remove(); if (Platform.OS === 'web') document.removeEventListener('visibilitychange', foreground); };
  }, [session.token]);
  async function update(value: Preferences) {
    if (busy || inFlight.current) return;
    inFlight.current = true; ++revision.current; setWorking(true); setError(''); onBusyChange(true);
    try { const saved = await request<Preferences>(session, '/me/notifications/preferences', 'PUT', value); if (mounted.current) setPreferences(saved); }
    catch { if (mounted.current) setError('Could not save notifications. Try again.'); }
    finally { inFlight.current = false; if (mounted.current) setWorking(false); onBusyChange(false); }
  }
  const disabled = busy || working || !preferences;
  const value = !preferences ? 'Unavailable' : !preferences.expense_updates ? 'Off' : push.state.enabled ? preferences.email_reminders ? 'Push and email' : 'Push' : preferences.email_reminders ? 'Email only' : 'In app only';
  function close() { setOpen(false); requestAnimationFrame(() => row.current?.focus()); }
  useEffect(() => {
    if (Platform.OS !== 'web' || !open) return;
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busy && !working) { event.preventDefault(); event.stopPropagation(); close(); } };
    document.addEventListener('keydown', escape, true);
    return () => document.removeEventListener('keydown', escape, true);
  }, [open, busy, working]);
  return <><SettingsRow rowRef={row} icon="notifications" label="Notifications" value={value} disabled={busy} onPress={() => { setOpen(true); void load(); }} />
    <Portal><Dialog visible={open} dismissable={!busy && !working} onDismiss={() => { if (!busy && !working) close(); }}><Dialog.Title>Notifications</Dialog.Title>
      <Dialog.ScrollArea style={{ maxHeight: 440 }}><ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingVertical: 12, gap: 12 }}>
        {preferences && <><NotificationSwitch label="Expense updates" checked={preferences.expense_updates} disabled={!!disabled} onChange={expense_updates => void update({ ...preferences, expense_updates })} />
          <NotificationSwitch label="Daily unread email reminders" checked={preferences.email_reminders} disabled={!!disabled || !preferences.expense_updates} onChange={email_reminders => void update({ ...preferences, email_reminders })} />
          <Text style={ui.caption}>Email reminders arrive after a day away. Expense updates off stops push and email.</Text></>}
        <PushSettings push={push} busy={busy} onBusyChange={onBusyChange} />
        {!!error && <><ErrorText>{error}</ErrorText>{!preferences && <Button title="Retry" disabled={busy || working} onPress={() => void load()} />}</>}
      </ScrollView></Dialog.ScrollArea><Dialog.Actions><Button title="Done" kind="text" disabled={busy || working} onPress={close} /></Dialog.Actions></Dialog></Portal>
  </>;
}
