import React, { useState } from 'react';
import { ActivityIndicator } from 'react-native';
import { Menu, Text } from 'react-native-paper';
import type { Command } from './types';
import { syncStatus } from './syncState';
import DialogFocus from './DialogFocus';
import { Button, Icon, useUI } from './ui';

export default function SyncStatus(props: { commands: Command[]; pendingFiles: number; drafts: boolean; confirmedAt: string | null; durable: boolean; syncing: boolean; problem: boolean; online?: boolean; reviewRequired?: boolean; updatesAvailable?: boolean; onShowUpdates?: () => void; onExport?: () => void; onRetry?: () => void; onPress: () => void }) {
  const { ui, palette } = useUI(), status = syncStatus(props), [open, setOpen] = useState(false);
  const updates = props.updatesAvailable && ['Synced', 'Online'].includes(status.label);
  const label = updates ? 'Updates available' : status.label;
  const color = updates ? palette.accent : ['Synced', 'Online'].includes(status.label) ? palette.positive : status.label === 'Needs attention' ? palette.warning : palette.muted;
  const icon = updates ? 'info' : ['Synced', 'Online'].includes(status.label) ? 'check' : status.label === 'Needs attention' ? 'info' : status.label === 'Offline' ? 'offline' : 'history';
  return <Menu visible={open} onDismiss={() => setOpen(false)} anchorPosition="bottom" overlayAccessibilityLabel="Close sync status" contentStyle={{ maxWidth: 288, padding: 16, borderRadius: 12 }} anchor={
    <Button kind="plain" accessibilityRole="button" accessibilityLabel={`Sync status: ${label}`} accessibilityHint="Show sync details" accessibilityState={{ expanded: open }} onPress={() => setOpen(value => !value)} style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
      {status.label === 'Syncing' ? <ActivityIndicator color={palette.accent} size={22} /> : <Icon name={icon} size={22} color={color} />}
    </Button>
  }>
    <DialogFocus active={open} label="Sync details" onEscape={() => setOpen(false)} style={{ gap: 8, maxWidth: 256 }}>
      <Text accessibilityRole="header" aria-level={2} style={ui.rowTitle}>{label}</Text>
      <Text style={ui.body}>{updates ? 'New changes are available.' : status.detail}</Text>
      {props.updatesAvailable && <Button title="Show updates" kind="text" onPress={() => { setOpen(false); props.onShowUpdates?.(); }} />}
      {props.commands.length > 0 && <Button title="View saved changes" kind="text" onPress={() => { setOpen(false); props.onPress(); }} />}
      {!!props.pendingFiles && props.onRetry && <Button title="Retry uploads" kind="text" disabled={props.syncing || props.online === false} onPress={() => { setOpen(false); props.onRetry?.(); }} />}
      {!props.durable && props.drafts && !props.commands.length && props.onExport && <Button title="Export saved work" kind="text" onPress={() => { setOpen(false); props.onExport?.(); }} />}
    </DialogFocus>
  </Menu>;
}
