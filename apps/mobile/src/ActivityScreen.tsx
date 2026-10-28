import { categoryIcon, categoryMeaning, expenseCategory } from './categoryIcons';
import type { ExpenseIcons, ExpenseIconRef } from './categoryIcons';
import React, { useRef } from 'react';
import Mascot from './Mascot';
import { useScrollPagination } from './useScrollPagination';
import { pageContentStyle } from './AppNavigation';
import { FlatList, StyleSheet, View } from 'react-native';
import { Text } from 'react-native-paper';
import { formatMoney } from './accounting';
import { activityDay, activityPresentation, activityTime } from './activityPresentation';
import type { ActivityItem, ActivityTarget } from './types';
import { AmountText, balanceColor, Button, ErrorText, Icon, IconBadge, useUI } from './ui';

type Props = {
  categoryIcons?: ExpenseIcons; onVisibleExpenses?: (refs: ExpenseIconRef[]) => void; header?: React.ReactNode; footer?: React.ReactNode; items: ActivityItem[]; busy: boolean; emptyVerified?: boolean; showEmpty?: boolean; error?: string | null; hasMore?: boolean;
  cursor?: string | null; pagingScope?: string; active?: boolean; online?: boolean;
  onRefresh: () => void; onLoadMore?: (signal?: AbortSignal) => Promise<boolean>; onOpen: (target: ActivityTarget) => void;
};

/** This is an event feed. Only canonical bill content in its destination can mark a bill seen. */
export default function ActivityScreen({ categoryIcons = {}, onVisibleExpenses, header, footer, items, busy, error, hasMore, cursor, pagingScope = 'activity', active = true, online = true, emptyVerified = false, showEmpty = true, onRefresh, onLoadMore, onOpen }: Props) {
  const { ui } = useUI();
  const list = useRef<FlatList<ActivityItem>>(null);
  const visible = useRef(onVisibleExpenses); visible.current = onVisibleExpenses;
  const viewable = useRef(({ viewableItems }: { viewableItems: { isViewable: boolean; item: ActivityItem }[] }) => visible.current?.(viewableItems.filter(row => row.isViewable && row.item.bill && !row.item.bill.deleted).map(({ item }) => ({ ...item.bill!, id: item.bill!.id, title: item.bill!.description, groupId: item.group.id }))));
  const paging = useScrollPagination({ scope: pagingScope, cursor, enabled: active && online && !busy && !error,
    load: signal => onLoadMore?.(signal) ?? Promise.resolve(false) });
  return <FlatList onViewableItemsChanged={viewable.current} ref={list} data={items} keyExtractor={item => item.id} scrollEventThrottle={100} onEndReachedThreshold={0.3}
    contentInsetAdjustmentBehavior="automatic"
    contentContainerStyle={[pageContentStyle, { gap: 0 }]} onRefresh={onRefresh} refreshing={false}
    ListHeaderComponent={<>{header}{error ? <View style={s.message}><ErrorText live>{error}</ErrorText><Button title="Try again" disabled={busy} onPress={onRefresh} /></View> : null}</>}
    ListEmptyComponent={showEmpty && !hasMore && !error ? <View style={s.empty}><Mascot size="empty" visible={emptyVerified && !busy} /><Text accessibilityLiveRegion="polite" style={ui.caption}>No activity yet</Text></View> : undefined}
    renderItem={({ item, index }) => <ActivityRow categoryIcons={categoryIcons} item={item} busy={busy} onOpen={onOpen} showDay={index === 0 || activityDay(items[index - 1].created_at) !== activityDay(item.created_at)} />}
    ListFooterComponent={<>{footer}<View style={s.message}>{paging.canLoadMore && !paging.failed && <Button title="Load older" kind="text" disabled={paging.loading} onPress={paging.loadMore} />}{paging.failed && <><ErrorText live>Could not load earlier activity.</ErrorText><Button title="Retry" kind="text" onPress={paging.retry} /></>}</View></>} />;
}

function ActivityRow({ categoryIcons = {}, item, busy, showDay, onOpen }: {
  categoryIcons?: ExpenseIcons; item: ActivityItem; busy: boolean; showDay: boolean; onOpen: Props['onOpen'];
}) {
  const { ui, palette } = useUI();
  const category = item.bill && !item.bill.deleted && !['bill_reversed', 'bill_deleted'].includes(item.kind) ? expenseCategory({ ...item.bill, id: item.bill.id, title: item.bill.description, groupId: item.group.id }, categoryIcons) : null;
  const meaning = categoryMeaning(category);
  const row = activityPresentation(item), day = activityDay(item.created_at);
  return <>
    {showDay && <Text accessibilityRole="header" aria-level={2} style={[ui.caption, s.day]}>{day}</Text>}
    <Button kind="plain" accessibilityRole="button" accessibilityLabel={`${row.title}${meaning ? ', ' + meaning : ''}${row.amount ? `, ${formatMoney(row.amount)}` : ''}, ${item.group.name}, ${day}, ${activityTime(item.created_at)}`} disabled={busy} onPress={() => onOpen(row.target)} style={({ pressed }) => [ui.row, s.row, pressed && s.pressed]}>
      <IconBadge name={item.bill && !item.bill.deleted && !['bill_reversed', 'bill_deleted'].includes(item.kind) ? categoryIcon(category) : row.icon} size={21} />
      <View style={ui.rowBody}>
        <Text numberOfLines={1} ellipsizeMode="tail" style={ui.rowTitle}>{row.title}</Text>
        <Text numberOfLines={1} ellipsizeMode="tail" style={ui.rowSub}>{item.group.name} · {activityTime(item.created_at)}</Text>
        {item.kind === 'payment_recorded' && item.payment?.reversed && <Text style={ui.rowSub}>Record later reversed</Text>}
      </View>
      <View style={s.trailing}>{row.amount && <AmountText amount={row.amount} style={[s.amount, { color: row.cashflow === '0' ? palette.text : balanceColor(row.cashflow, palette) }]} />}<Icon name="next" size={16} color={palette.muted} /></View>
    </Button>
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
