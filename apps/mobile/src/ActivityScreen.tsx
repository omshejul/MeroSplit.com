import React from 'react';
import Mascot from './Mascot';
import { Pressable, StyleSheet, View } from 'react-native';
import { ActivityIndicator, Text } from 'react-native-paper';
import { formatMoney } from './accounting';
import { activityDay, activityPresentation, activityTime } from './activityPresentation';
import type { ActivityItem, ActivityTarget } from './types';
import { AmountText, balanceColor, Button, ErrorText, Icon, IconBadge, useUI } from './ui';

type Props = {
  items: ActivityItem[]; busy: boolean; emptyVerified?: boolean; error?: string | null; hasMore?: boolean;
  onRefresh: () => void; onLoadMore?: () => void; onOpen: (target: ActivityTarget) => void;
};

/** This is an event feed. Only canonical bill content in its destination can mark a bill seen. */
export default function ActivityScreen({ items, busy, error, hasMore, emptyVerified = false, onRefresh, onLoadMore, onOpen }: Props) {
  const { ui } = useUI();
  return <View style={s.content}>
    {!!error && <View style={s.message}><ErrorText live>{error}</ErrorText><Button title="Try again" disabled={busy} onPress={onRefresh} /></View>}
    {!items.length && !hasMore && !error && <View style={s.empty}>
      {emptyVerified && !busy && <Mascot size="empty" />}
      {busy && <ActivityIndicator accessibilityLabel="Loading activity" />}
      <Text style={ui.caption}>{busy ? 'Loading activity…' : 'No activity yet'}</Text>
    </View>}
    {items.map((item, index) => <ActivityRow key={item.id} item={item} busy={busy} onOpen={onOpen}
      showDay={index === 0 || activityDay(items[index - 1].created_at) !== activityDay(item.created_at)} />)}
    {!!hasMore && !!onLoadMore && <Button title="Older activity" disabled={busy} onPress={onLoadMore} />}
  </View>;
}

function ActivityRow({ item, busy, showDay, onOpen }: {
  item: ActivityItem; busy: boolean; showDay: boolean; onOpen: Props['onOpen'];
}) {
  const { ui, palette } = useUI();
  const row = activityPresentation(item), day = activityDay(item.created_at);
  return <>
    {showDay && <Text accessibilityRole="header" style={[ui.caption, s.day]}>{day}</Text>}
    <Pressable accessibilityRole="button" accessibilityLabel={`${row.title}${row.amount ? `, ${formatMoney(row.amount)}` : ''}, ${item.group.name}, ${day}, ${activityTime(item.created_at)}`} disabled={busy} onPress={() => onOpen(row.target)} style={({ pressed }) => [ui.row, s.row, pressed && s.pressed]}>
      <IconBadge name={row.icon} size={21} />
      <View style={ui.rowBody}>
        <Text numberOfLines={1} ellipsizeMode="tail" style={ui.rowTitle}>{row.title}</Text>
        <Text numberOfLines={1} ellipsizeMode="tail" style={ui.rowSub}>{item.group.name} · {activityTime(item.created_at)}</Text>
        {item.kind === 'payment_recorded' && item.payment?.reversed && <Text style={ui.rowSub}>Record later reversed</Text>}
        {item.kind === 'payment_reversed' && <Text style={ui.rowSub}>No bank transfer was reversed</Text>}
      </View>
      <View style={s.trailing}>{row.amount && <AmountText amount={row.amount} style={[s.amount, { color: row.cashflow === '0' ? palette.text : balanceColor(row.cashflow, palette) }]} />}<Icon name="next" size={16} color={palette.muted} /></View>
    </Pressable>
  </>;
}

const s = StyleSheet.create({
  content: { gap: 4 },
  row: { minHeight: 64 },
  day: { paddingTop: 12, paddingBottom: 4, fontWeight: '600' },
  trailing: { alignItems: 'flex-end', gap: 3, flexShrink: 0 },
  amount: { fontSize: 16, lineHeight: 22, textAlign: 'auto' },
  empty: { alignItems: 'center', gap: 10, paddingVertical: 24 },
  message: { gap: 10, paddingVertical: 12 },
  pressed: { opacity: 0.65 },
});
