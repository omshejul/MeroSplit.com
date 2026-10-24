import React from 'react';
import Mascot from './Mascot';
import { Pressable, StyleSheet, View } from 'react-native';
import { Text } from 'react-native-paper';
import { position } from './GroupScreen';
import { groupDisplayName, selfParticipant } from './personalBalances';
import type { CachedGroup, Command } from './types';
import { Avatar, balanceColor, Icon, IconBadge, radii, useUI } from './ui';

function GroupListRow({ row, waiting, userId, busy, onOpen }: { row: CachedGroup; waiting: Command[]; userId?: string; busy: boolean; onOpen: () => void }) {
  const { palette, ui } = useUI();
  const group = row.group, name = groupDisplayName(group, userId), me = userId ? selfParticipant(group, userId) : undefined;
  const attention = waiting.some(value => value.state !== 'pending');
  return <Pressable accessibilityRole="button" disabled={busy} style={[styles.row, { borderBottomColor: palette.line }]} onPress={onOpen}>
    {group.is_direct ? <Avatar name={name} /> : <IconBadge name="groups" size={24} />}
    <View style={ui.rowBody}>
      <Text numberOfLines={1} ellipsizeMode="tail" accessibilityLabel={name} style={ui.rowTitle}>{name}{group.archived ? ' · Archived' : ''}</Text>
      <Text style={[ui.rowSub, me && { color: balanceColor(group.balances[me.id] ?? '0', palette) }]}>{me ? position('You', group.balances[me.id] ?? '0') : 'Pending sync'}</Text>
      {waiting.length > 0 && <Text style={{ fontSize: 13, color: palette.warning }}>{attention ? 'Needs review' : 'Pending sync'}</Text>}
    </View>
    <Icon name="next" size={18} color={palette.muted} />
  </Pressable>;
}
export default function GroupList({ groups, commands, userId, busy, direct, emptyLabel, emptyVerified = false, decorated = false, onOpen }: { groups: CachedGroup[]; commands: Command[]; userId?: string; busy: boolean; direct: boolean; emptyLabel?: string; emptyVerified?: boolean; decorated?: boolean; onOpen: (row: CachedGroup) => void }) {
  const { palette, ui } = useUI();
  if (!groups.length) {
    const caption = <Text style={ui.caption}>{emptyLabel ?? (direct ? 'No people yet' : 'No groups yet')}</Text>;
    return decorated && !direct ? <Mascot size="empty" visible={emptyVerified && !busy && !commands.length}>{caption}</Mascot> : caption;
  }
  return <View role="list" accessibilityLabel={direct ? 'People' : 'Groups'} style={[styles.list, { backgroundColor: palette.surface }]}>{groups.map(row => <View role="listitem" key={row.group.id}><GroupListRow row={row} waiting={commands.filter(value => value.group_id === row.group.id)} userId={userId} busy={busy} onOpen={() => onOpen(row)} /></View>)}</View>;
}
const styles = StyleSheet.create({
  list: { borderRadius: radii.surface, paddingHorizontal: 12 },
  row: { minHeight: 56, flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth },
});
