import React, { useRef, useState } from 'react';
import { Platform, StyleSheet, useWindowDimensions, View } from 'react-native';
import { Text } from 'react-native-paper';
import { ErrorState, LoadingState } from './UIStates';
import { Dialog, DialogScrollBody } from './DialogParts';
import KeyboardDialog from './KeyboardDialog';
import PushSettings, { PushStatus, type PushControls } from './PushSettings';
import NotificationSwitch from './NotificationSwitch';
import BalanceStatements from './BalanceStatements';
import { channelSummary } from './channelPreferences';
import type { NotificationChannels } from './useNotificationChannels';
import type { Session } from './types';
import { Button, SettingsRow, useUI } from './ui';

export default function AccountNotifications({ session, push, channels, busy }: { session: Session; push: PushControls; channels: NotificationChannels; busy: boolean; onBusyChange?: (value: boolean) => void }) {
  const { height, fontScale } = useWindowDimensions(), { ui, palette } = useUI();
  const [open, setOpen] = useState(false), row = useRef<React.ComponentRef<typeof View>>(null);
  const { value, pending, saving, error } = channels.state;
  const localFailure = error.startsWith('Could not save on this device');
  function close() { setOpen(false); requestAnimationFrame(() => row.current?.focus()); }
  return <><SettingsRow rowRef={row} icon="notifications" label="Notifications" value={value ? channelSummary(push.state.configured, value.email_notifications) : undefined} disabled={busy} onPress={() => setOpen(true)} />
    <KeyboardDialog label="Notifications" visible={open} dismissable={!busy} onDismiss={() => { if (!busy) close(); }}><Dialog.Title aria-level={2}>Notifications</Dialog.Title>
      <DialogScrollBody fixedHeight maxHeight={Platform.OS === 'web' ? Math.min(520, Math.max(0, height - 224)) : 400} gap={8} paddingHorizontal={16} paddingVertical={8}>
        <View style={{ minHeight: Math.ceil(40 * (fontScale ?? 1)) }}><Text accessibilityLiveRegion="polite" style={[ui.caption, { fontSize: 12 }]}>{localFailure ? error : saving ? 'Saving…' : pending && !localFailure ? error || 'Saved on this device. Syncing…' : 'Changes save automatically'}</Text></View>
        {value && <>
          <View style={{ borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: palette.line }}><PushSettings push={push} busy={busy} /></View>
          <View style={{ borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: palette.line }}><NotificationSwitch icon="mail" label="Email notifications" checked={value.email_notifications} disabled={busy || !value.email_available} onChange={email_notifications => { void channels.change({ email_notifications }).catch(() => {}); }} /></View>
          <PushStatus push={push} busy={busy} hideSyncFeedback={pending || saving} />
          {!value.email_available && <Text style={ui.caption}>Add a verified email address to receive emails.</Text>}
          {value.email_notifications ? <View style={{ paddingLeft: 12 }}><BalanceStatements session={session} visible={open} channels={channels} busy={busy} /></View> : <Text style={[ui.caption, { paddingLeft: 12 }]}>Turn on email notifications to receive balance statements.</Text>}
        </>}
        {!!error && (!value || localFailure) && <ErrorState error={error} disabled={busy} retryLabel="Retry notifications" onRetry={() => void channels.retry()} />}
        {pending && !!error && !localFailure && <Button title="Retry sync" icon="refresh" kind="text" disabled={busy} onPress={() => void channels.retry()} />}
        {!value && !error && <LoadingState spinner label="Loading notifications…" style={{ minHeight: 180, justifyContent: 'center' }} />}
      </DialogScrollBody></KeyboardDialog>
  </>;
}
