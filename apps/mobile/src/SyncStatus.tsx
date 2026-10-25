import React from 'react';
import { Pressable } from 'react-native';
import { Text } from 'react-native-paper';
import type { Command } from './types';
import { syncStatus } from './syncState';
import { useUI } from './ui';
export default function SyncStatus(props: { commands: Command[]; pendingFiles: number; drafts: boolean; confirmedAt: string | null; durable: boolean; syncing: boolean; problem: boolean; reviewRequired?: boolean; onPress: () => void }) {
  const { ui, palette } = useUI(), status = syncStatus(props);
  return <Pressable accessibilityRole="button" accessibilityLabel={`${status.label}. ${status.detail}`} accessibilityHint="Open Me to review saved changes" onPress={props.onPress} style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: 24, paddingBottom: 6 }}>
    <Text accessibilityLiveRegion="polite" style={[ui.caption, { color: status.label === 'Needs attention' ? palette.error : palette.muted }]}>{status.label}{props.commands.length ? ` · ${props.commands.length}` : ''}</Text>
  </Pressable>;
}
