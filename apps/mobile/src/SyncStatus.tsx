import React, { useState } from 'react';
import { ActivityIndicator, Pressable } from 'react-native';
import { Menu, Text } from 'react-native-paper';
import type { Command } from './types';
import { syncStatus } from './syncState';
import DialogFocus from './DialogFocus';
import { Button, Icon, useUI } from './ui';

export default function SyncStatus(props: { commands: Command[]; pendingFiles: number; drafts: boolean; confirmedAt: string | null; durable: boolean; syncing: boolean; problem: boolean; online?: boolean; reviewRequired?: boolean; updatesAvailable?: boolean; onShowUpdates?: () => void; onPress: () => void }) {
  const { ui, palette } = useUI(), status = syncStatus(props), [open, setOpen] = useState(false);
  const updates = props.updatesAvailable && status.label === 'Synced';
  const label = updates ? 'Updates available' : status.label;
  const color = updates ? palette.accent : status.label === 'Synced' ? palette.positive : status.label === 'Needs attention' ? palette.warning : palette.muted;
  const icon = updates ? 'info' : status.label === 'Synced' ? 'check' : status.label === 'Needs attention' ? 'info' : status.label === 'Offline' ? 'offline' : 'history';
  return <Menu visible={open} onDismiss={() => setOpen(false)} anchorPosition="bottom" overlayAccessibilityLabel="Close sync status" contentStyle={{ maxWidth: 288, padding: 16, borderRadius: 12 }} anchor={
    <Pressable accessibilityRole="button" accessibilityLabel={`Sync status: ${label}`} accessibilityHint="Show sync details" accessibilityState={{ expanded: open }} onPress={() => setOpen(value => !value)} style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
      {status.label === 'Syncing' ? <ActivityIndicator color={palette.accent} size={22} /> : <Icon name={icon} size={22} color={color} />}
    </Pressable>
  }>
    <DialogFocus active={open} label="Sync details" onEscape={() => setOpen(false)} style={{ gap: 8, maxWidth: 256 }}>
      <Text accessibilityRole="header" aria-level={2} style={ui.rowTitle}>{label}</Text>
      <Text style={ui.body}>{updates ? 'New changes are available.' : status.detail}</Text>
      {!props.durable && !props.commands.length && !props.pendingFiles && !props.drafts && <Text style={ui.body}>This tab is using temporary storage. Your synced records are safe on the server.</Text>}
      {props.updatesAvailable && <Button title="Show updates" kind="text" onPress={() => { setOpen(false); props.onShowUpdates?.(); }} />}
      {status.label === 'Needs attention' && <Button title="View saved changes" kind="text" onPress={() => { setOpen(false); props.onPress(); }} />}
    </DialogFocus>
  </Menu>;
}
