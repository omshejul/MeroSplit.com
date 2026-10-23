import React, { useMemo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { ActivityIndicator, Text } from 'react-native-paper';
import { formatMoney } from './accounting';
import { activityDay, activityPresentation, activityTime } from './activityPresentation';
import type { ActivityItem, ActivityTarget } from './types';
import { balanceColor, Button, Icon, radii, useUI } from './ui';
import type { Palette } from './ui';

type Props = {
  items: ActivityItem[]; busy: boolean; error?: string | null; hasMore?: boolean;
  onRefresh: () => void; onLoadMore?: () => void; onOpen: (target: ActivityTarget) => void;
};

/** This is an event feed. Only canonical bill content in its destination can mark a bill seen. */
export default function ActivityScreen({ items, busy, error, hasMore, onRefresh, onLoadMore, onOpen }: Props) {
  const { ui, palette } = useUI();
  const s = useMemo(() => styles(palette), [palette]);
  let previousDay = '';
  return <View style={s.content}>
    {!!error && <View style={s.message}><Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={ui.error}>{error}</Text><Button title="Try again" disabled={busy} onPress={onRefresh} /></View>}
    {!items.length && !hasMore && !error && <View style={s.empty}>
      {busy && <ActivityIndicator accessibilityLabel="Loading activity" />}
      <Text style={ui.caption}>{busy ? 'Loading activity…' : 'No activity yet'}</Text>
    </View>}
    {items.map(item => {
      const row = activityPresentation(item), day = activityDay(item.created_at), heading = day !== previousDay;
      previousDay = day;
      return <React.Fragment key={item.id}>
        {heading && <Text accessibilityRole="header" style={[ui.caption, s.day]}>{day}</Text>}
        <Pressable accessibilityRole="button" accessibilityLabel={`${row.title}${row.amount ? `, ${formatMoney(row.amount)}` : ''}, ${item.group.name}, ${day}, ${activityTime(item.created_at)}`} disabled={busy} onPress={() => onOpen(row.target)} style={({ pressed }) => [ui.row, s.row, pressed && s.pressed]}>
          <View style={s.mark}><Icon name={row.icon} size={21} /></View>
          <View style={ui.rowBody}>
            <Text numberOfLines={1} ellipsizeMode="tail" style={ui.rowTitle}>{row.title}</Text>
            <Text numberOfLines={1} ellipsizeMode="tail" style={ui.rowSub}>{item.group.name} · {activityTime(item.created_at)}</Text>
            {item.kind === 'payment_recorded' && item.payment?.reversed && <Text style={ui.rowSub}>Record later reversed</Text>}
            {item.kind === 'payment_reversed' && <Text style={ui.rowSub}>No bank transfer was reversed</Text>}
          </View>
          <View style={s.trailing}>{row.amount && <Text style={[s.amount, { color: row.cashflow === '0' ? palette.text : balanceColor(row.cashflow, palette) }]}>{formatMoney(row.amount)}</Text>}<Icon name="next" size={16} color={palette.muted} /></View>
        </Pressable>
      </React.Fragment>;
    })}
    {!!hasMore && !!onLoadMore && <Button title="Older activity" disabled={busy} onPress={onLoadMore} />}
  </View>;
}

const styles = (colors: Palette) => StyleSheet.create({
  content: { gap: 4 },
  row: { minHeight: 64 },
  day: { paddingTop: 12, paddingBottom: 4, fontWeight: '600' },
  mark: { width: 36, height: 36, borderRadius: radii.control, backgroundColor: colors.soft, alignItems: 'center', justifyContent: 'center' },
  trailing: { alignItems: 'flex-end', gap: 3, flexShrink: 0 },
  amount: { fontSize: 16, lineHeight: 22, fontWeight: '600', fontVariant: ['tabular-nums'] },
  empty: { alignItems: 'center', gap: 10, paddingVertical: 24 },
  message: { gap: 10, paddingVertical: 12 },
  pressed: { opacity: 0.65 },
});
