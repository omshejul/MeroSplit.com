import StaggerItem, { type ListEntry } from './StaggerItem';
import DetailDialog from './DetailDialog';
import TransactionIcon from './TransactionIcon';
import { categoryIcon, categoryMeaning, expenseCategory } from './categoryIcons';
import type { ExpenseIcons } from './categoryIcons';
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import BillPeople from './BillPeople';
import BalanceExplanation, { type BalanceSelection } from './BalanceExplanationDialog';
import { balanceKey } from './balanceExplanation';
import type { BalanceSource } from './balanceExplanationStorage';
import { Animated, Keyboard, Platform, FlatList, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { useScrollPagination } from './useScrollPagination';
import { pageContentStyle } from './AppNavigation';
import { expenseBalanceChange, formatMoney } from './accounting';
import { Text } from 'react-native-paper';
import { personalSettlements, personalTransfers } from './personalBalances';
import { paymentPresentation } from './activityPresentation';
import { VisibleExpense } from './useExpenseNotices';
import type { NoticeVisibility } from './useExpenseNotices';
import type { BillRow, Command, Expense, Group, GroupTransaction, Participant, Settlement, HistoryResource, HistoryWindow } from './types';
import { SectionHeading, AmountText, Avatar, balanceColor, Button, Icon, radii, useUI } from './ui';

type Transfer = { sender: string; recipient: string; amount: string };
type Props = {
  categoryIcons?: ExpenseIcons; noticeVisibility?: NoticeVisibility; header?: React.ReactNode;
  revision?: number; onUpdatesAvailable?: (available: boolean) => void; previewError?: string;
  group: Group; accepted: Group; pending: Command[]; busy: boolean; selfId: string;
  onLoadBalanceGroup?: (expected: Group) => Promise<BalanceSource>;
  onHistoryPage?: (resource: HistoryResource, direction: 'next' | 'previous' | 'search', query?: string, signal?: AbortSignal, target?: Group) => Promise<boolean>;
  pagingScope?: string; active?: boolean; online?: boolean; onRefresh?: () => void; refreshing?: boolean; onVisibleBills?: (ids: string[]) => void; onPrefetchBill?: (bill: BillRow) => void; onPrefetchPayment?: (payment: Settlement) => void;
  onExpense: (expense: BillRow) => void; onPayment: (payment: Settlement) => void; onSettle: (transfer?: Transfer) => void;
  onReverse: (settlement: Settlement) => void;
  onRemind?: (transfer: Transfer) => Promise<void>;
};
export const position = (name: string, value: string) => BigInt(value) > 0n ? `${name} ${name === 'You' ? 'are' : 'is'} owed ${formatMoney(value)}` : BigInt(value) < 0n ? `${name} ${name === 'You' ? 'owe' : 'owes'} ${formatMoney((-BigInt(value)).toString())}` : `${name} ${name === 'You' ? 'are' : 'is'} settled up`;
const displayDate = (value?: string | null) => {
  if (!value) return 'Date unavailable';
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
};
const billImpact = (value: string) => BigInt(value) === 0n ? 'No balance impact' : `Balance ${BigInt(value) > 0n ? '+' : '−'}${formatMoney((BigInt(value) < 0n ? -BigInt(value) : BigInt(value)).toString())}`;
const participantName = (participants: Participant[], selfId: string, id: string) => id === selfId ? 'You' : participants.find(person => person.id === id)?.name ?? 'Former member';
function PagingFooter({ paging }: { paging: ReturnType<typeof useScrollPagination> }) {
  return <View style={{ paddingVertical: 12, gap: 8 }}>{paging.canLoadMore && !paging.failed && <Button title="Load older" kind="text" disabled={paging.loading} onPress={paging.loadMore} />}{paging.failed && <><Text>Could not load earlier records.</Text><Button title="Retry" kind="text" onPress={paging.retry} /></>}</View>;
}

function LegacyPayments({ group, selfId, accepted, busy, onPayment, onPrefetchPayment, onPage, scope, enabled }: {
  group: Group; selfId: string; accepted: Group; busy: boolean; onPayment: Props['onPayment']; onPrefetchPayment?: Props['onPrefetchPayment']; onPage: Props['onHistoryPage']; scope: string; enabled: boolean;
}) {
  const ref = useRef<React.ComponentRef<typeof ScrollView>>(null), payments = personalSettlements(group, selfId);
  const paging = useScrollPagination({ scope: scope + '|payments', cursor: group.history?.settlements?.next_cursor,
    enabled: enabled && !busy, load: signal => onPage?.('settlements', 'next', undefined, signal, accepted) ?? Promise.resolve(false) });
  return <ScrollView ref={ref} nestedScrollEnabled scrollEventThrottle={100} style={{ maxHeight: 320 }}>
    {payments.map(payment => <PaymentRow key={payment.id} payment={payment} accepted={accepted} group={group} selfId={selfId} busy={busy} onPayment={onPayment} onPrefetchPayment={onPrefetchPayment} />)}
    {!payments.length && <Text>{group.history?.settlements?.next_cursor ? 'No payments on this page.' : 'No payments recorded.'}</Text>}
    <PagingFooter paging={paging} />
  </ScrollView>;
}

function PersonalTransferRow({ transfer, group, selfId, disabled, onSettle, onRemind, onExplain }: { transfer: Transfer; group: Group; selfId: string; disabled: boolean; onSettle: Props['onSettle']; onRemind?: Props['onRemind']; onExplain: (transfer: Transfer, restoreFocus: () => void) => void }) {
  const { palette: colors, ui } = useUI();
  const [reminding, setReminding] = useState(false);
  const row = useRef<React.ComponentRef<typeof View>>(null);
  const outgoing = transfer.sender === selfId, counterpart = outgoing ? transfer.recipient : transfer.sender;
  const person = group.participants.find(person => person.id === counterpart), removed = person?.removed;
  const name = participantName(group.participants, selfId, counterpart);
  const action = outgoing && person?.user_id != null && !!person.payment_profile?.vpa ? 'Pay' : 'Record';
  return <View style={ui.row}>
    <Button kind="plain" ref={row} accessibilityRole="button" accessibilityLabel={`Why ${outgoing ? 'you owe' : 'you are owed'} ${formatMoney(transfer.amount)} ${outgoing ? 'to' : 'by'} ${name}`} onPress={() => onExplain(transfer, () => row.current?.focus())} style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44 }}>
      <Avatar name={name} photo={person?.profile_photo} />
      <View style={ui.rowBody}><Text numberOfLines={1} ellipsizeMode="tail" style={[ui.rowTitle, s.logTitle]}>{name}</Text><Text style={[ui.rowSub, s.logCaption]}>{outgoing ? 'You owe' : 'Owes you'}{removed ? ' · Removed' : ''}</Text></View>
      <AmountText amount={transfer.amount} style={[s.balanceAmount, { color: outgoing ? colors.negative : colors.positive }]} />
    </Button>
    <Button title={action} kind={action === 'Pay' ? 'outlined' : 'text'} icon={action === 'Pay' ? 'pay' : undefined} compact accessibilityLabel={`${action} payment ${outgoing ? 'to' : 'from'} ${name}, ${formatMoney(transfer.amount)}`} disabled={disabled || !!removed} onPress={() => onSettle(transfer)} />
    {!outgoing && person?.user_id != null && onRemind && <Button title="Remind" kind="text" compact accessibilityLabel={`Remind ${name} about ${formatMoney(transfer.amount)}`} disabled={disabled || !!removed || reminding} onPress={() => { if (reminding) return; setReminding(true); void onRemind(transfer).catch(() => {}).finally(() => setReminding(false)); }} />}
  </View>;
}

// Month over day, plus the year only when it is not this year. The row's label carries the full date.
function LogDate({ date }: { date?: string | null }) {
  const { ui } = useUI();
  const parsed = date ? new Date(`${date}T12:00:00`) : null, value = parsed && !Number.isNaN(parsed.getTime()) ? parsed : null;
  return <View aria-hidden accessible={false} importantForAccessibility="no-hide-descendants" style={s.date}>
    {value ? <><Text style={[ui.rowSub, s.dateMonth]}>{value.toLocaleDateString('en-IN', { month: 'short' })}</Text><Text style={[ui.rowTitle, s.dateDay]}>{value.getDate()}</Text>
      {value.getFullYear() !== new Date().getFullYear() && <Text style={[ui.rowSub, s.dateMonth]}>{value.getFullYear()}</Text>}</> : <Text style={[ui.rowSub, s.dateDay]}>–</Text>}
  </View>;
}

// One compact log row for bills and payments: date, what happened, and (for bills) your balance effect.
function LogRow({ leading, date, label, busy, onPress, onPrefetch, trailing, children, payment = false }: { leading?: React.ReactNode; date?: string | null; label: string; busy: boolean; onPress: () => void; onPrefetch?: () => void; trailing?: React.ReactNode; children: React.ReactNode; payment?: boolean }) {
  const { ui, palette } = useUI();
  return <Button kind="plain" accessibilityRole="button" accessibilityLabel={label} disabled={busy} style={({ pressed }) => [ui.row, s.edgeRow, { borderBottomColor: `${palette.line}80` }, payment && { backgroundColor: palette.soft }, pressed && s.pressed]} onPress={onPress} onHoverIn={onPrefetch} onFocus={onPrefetch}>
    <LogDate date={date} />
    {leading}
    <View style={ui.rowBody}>{children}</View>
    {trailing}
  </Button>;
}

function PaymentRow({ payment, accepted, group, selfId, busy, onPayment, onPrefetchPayment }: Pick<Props, 'accepted' | 'group' | 'selfId' | 'busy' | 'onPayment' | 'onPrefetchPayment'> & { payment: Settlement }) {
  const { palette: colors, ui } = useUI();
  const isAccepted = accepted.settlements.some(record => record.id === payment.id) || accepted.transactions?.some(record => record.kind === 'payment' && record.payment.id === payment.id);
  if (!isAccepted && payment.provenance !== 'pending_manual') return null;
  const presentation = paymentPresentation(payment, selfId, id => participantName(group.participants, selfId, id));
  const status = isAccepted ? presentation.status : 'Pending sync';
  return <LogRow payment leading={<TransactionIcon name={payment.reversed ? 'refresh' : 'payment'} />} date={payment.date} busy={busy} onPress={() => onPayment(payment)} onPrefetch={() => onPrefetchPayment?.(payment)} label={`Payment, ${presentation.title}, ${formatMoney(payment.amount)}${status ? `, ${status}` : ''}, ${displayDate(payment.date)}`}>
    <View style={s.paymentLine}>
      <Text style={[ui.rowSub, s.logCaption, s.paymentSentence, { color: colors.text }]}>{presentation.title} <Text style={{ color: presentation.cashflow === '0' ? colors.text : balanceColor(presentation.cashflow, colors) }}>{formatMoney(payment.amount)}</Text>{!!status && <Text style={[ui.rowSub, s.logCaption]}> · {status}</Text>}</Text>
    </View>
  </LogRow>;
}

// Gross total stays "X paid ₹total"; the right side is only your balance effect from this bill.
function BillEffect({ change, involved, reversed }: { change: string; involved: boolean; reversed: boolean }) {
  const { palette: colors, ui } = useUI();
  const value = BigInt(change), color = value === 0n ? colors.muted : balanceColor(change, colors);
  const label = reversed ? 'Reversed' : value > 0n ? 'You lent' : value < 0n ? 'You borrowed' : involved ? 'No balance change' : 'Not involved';
  return <View style={s.trailing}>
    <Text style={[ui.rowSub, s.logCaption, { color, textAlign: 'right' }]}>{label}</Text>
    {value !== 0n && <AmountText amount={(value < 0n ? -value : value).toString()} style={[s.effect, { color }]} />}
  </View>;
}

function BillTimelineRow({ expense, group, selfId, busy, onExpense, onPrefetchBill, noticeVisibility, categoryIcons = {} }: Pick<Props, 'group' | 'selfId' | 'busy' | 'onExpense' | 'noticeVisibility' | 'categoryIcons' | 'onPrefetchBill'> & { expense: BillRow }) {
  const { ui } = useUI();
  const category = expense.deleted ? null : expenseCategory({ ...expense, groupId: group.id, title: expense.description }, categoryIcons);
  const meaning = categoryMeaning(category);
  const change = expenseBalanceChange(expense, selfId), name = (id: string) => participantName(group.participants, selfId, id);
  const paidBy = Object.entries(expense.paid).filter(([, amount]) => BigInt(amount) > 0n);
  const involved = BigInt(expense.shares[selfId] ?? '0') > 0n || BigInt(expense.paid[selfId] ?? '0') > 0n;
  const who = paidBy.length === 1 ? name(paidBy[0][0]) : paidBy.length === 2 ? `${name(paidBy[0][0])} and ${name(paidBy[1][0])}` : `${paidBy.length} people`;
  const payers = paidBy.map(([id, amount]) => `${name(id)} paid ${formatMoney(amount)}`).join(', ');
  return <VisibleExpense groupId={group.id} expense={expense} visibility={noticeVisibility}>
    <LogRow leading={<TransactionIcon name={expense.deleted ? 'refresh' : categoryIcon(category)} />} date={expense.date} busy={busy} onPress={() => onExpense(expense)} onPrefetch={() => onPrefetchBill?.(expense)} trailing={<BillEffect change={change} involved={involved} reversed={!!expense.deleted} />}
      label={`Bill, ${expense.description}, ${meaning ? meaning + ', ' : ''}total ${formatMoney(expense.total)}, ${expense.deleted ? 'reversed, no balance impact' : billImpact(change)}, ${payers || 'no payer recorded'}, Your share ${formatMoney(expense.shares[selfId] ?? '0')}, ${displayDate(expense.date)}`}>
      <Text numberOfLines={2} ellipsizeMode="tail" style={[ui.rowTitle, s.logTitle]}>{expense.description}</Text>
      <Text style={[ui.rowSub, s.logCaption]}>{paidBy.length ? `${who} paid ${formatMoney(expense.total)}` : `Total ${formatMoney(expense.total)}`}</Text>
    </LogRow>
  </VisibleExpense>;
}

function RecordSummary({ title, amount, amountColor, children, category, categoryText = false, reversed }: { categoryText?: boolean; reversed?: boolean; category?: string | null; title: string; amount: string; amountColor?: string; children: React.ReactNode }) {
  const { ui } = useUI();
  return <View style={s.summary}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      {category !== undefined && <TransactionIcon name={reversed ? 'refresh' : categoryIcon(category)} />}
      <SectionHeading accessibilityLabel={!categoryText && categoryMeaning(category) ? `${title}, ${categoryMeaning(category)}` : title}>{title}</SectionHeading>
    </View>
    <Text style={[ui.numeric, amountColor && { color: amountColor }]}>{formatMoney(amount)}</Text>
    {children}
  </View>;
}

function ParticipantAmountRow({ name, amount, photo }: { name: string; amount: string; photo?: import("./types").ProfilePhoto | null }) {
  const { ui } = useUI();
  return <View style={[ui.row, { flexWrap: 'wrap' }]}>
    <Avatar name={name} photo={photo} /><Text accessibilityLabel={name} style={[ui.rowTitle, s.flex, { minWidth: 120 }]}>{name}</Text><AmountText amount={amount} style={{ marginLeft: 'auto' }} />
  </View>;
}

function BillSearch({ value, onChange, onSearch, onClose, showSubmit, autoFocus }: { value: string; onChange: (value: string) => void; onSearch: () => void; onClose: () => void; showSubmit: boolean; busy: boolean; autoFocus: boolean }) {
  const { palette: colors, ui, inputColors } = useUI();
  const [focused, setFocused] = useState(false);
  return <View style={s.search}>
    <View style={[ui.input, s.searchField, { borderColor: focused ? colors.accent : 'transparent' }]}>
      {showSubmit ? <Button icon="search" iconOnly kind="text" accessibilityLabel="Run bill search" onPress={onSearch} style={s.searchAction} /> : <Icon name="search" size={20} color={colors.muted} />}
      <TextInput {...inputColors} autoFocus={autoFocus} accessibilityLabel="Search bills" placeholder="Search bills" placeholderTextColor={colors.muted} value={value} onChangeText={onChange} onSubmitEditing={onSearch} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} returnKeyType="search" autoCapitalize="none" autoCorrect={false} style={[ui.input, s.searchInput, Platform.OS === 'web' && { outlineWidth: 0 }]} />
    </View>
    <Button icon="close" iconOnly kind="text" accessibilityLabel="Close search" onPress={onClose} style={s.searchAction} />
  </View>;
}

export default function GroupScreen({ categoryIcons, header, noticeVisibility, group: incoming, accepted: incomingAccepted, previewError: incomingPreviewError = '', revision = 0, onUpdatesAvailable, pending, busy, selfId, pagingScope = incoming.id, active = true, online = true, onRefresh, refreshing = false, onVisibleBills, onPrefetchBill, onPrefetchPayment, onLoadBalanceGroup, onHistoryPage, onExpense, onPayment, onSettle, onRemind }: Props) {
  const { ui, motion } = useUI();
  // Background cache updates must not replace a page while someone is reading it.
  // Adopt both views together only for an explicit read or the user's saved changes.
  const [shown, setShown] = useState({ group: incoming, accepted: incomingAccepted, previewError: incomingPreviewError });
  const { group, accepted, previewError } = shown;
  const commandBodies = new Map(pending.map(command => [command.command_id, JSON.stringify(command.body)]));
  const ownChanges = pending.map(command => `${command.command_id}:${command.state}:${commandBodies.get(command.command_id)}`).join('|');
  const wasActive = useRef(active);
  const adoptedRevision = useRef(revision), savedCommands = useRef(commandBodies);
  const [opacity] = useState(() => new Animated.Value(1));
  useLayoutEffect(() => {
    const returning = active && !wasActive.current; wasActive.current = active;
    const deliberate = revision !== adoptedRevision.current || returning && (incoming !== group || incomingPreviewError !== previewError);
    const ownSave = pending.some(command => !savedCommands.current.has(command.command_id) || savedCommands.current.get(command.command_id) !== commandBodies.get(command.command_id));
    adoptedRevision.current = revision; savedCommands.current = commandBodies;
    if (!deliberate && !ownSave) return;
    if (deliberate && incoming.version !== group.version) {
      list.current?.scrollToOffset({ offset: 0, animated: false });
      opacity.stopAnimation();
      if (motion.enabled) {
        opacity.setValue(0.6);
        Animated.timing(opacity, { toValue: 1, duration: 180, useNativeDriver: Platform.OS !== 'web', isInteraction: false }).start();
      } else opacity.setValue(1);
    }
    setShown({ group: incoming, accepted: incomingAccepted, previewError: incomingPreviewError });
  }, [revision, ownChanges, active]);
  useEffect(() => { onUpdatesAvailable?.(incoming.version !== group.version || incomingPreviewError !== previewError); }, [incoming.version, group.version, incomingPreviewError, previewError, onUpdatesAvailable]);
  useEffect(() => () => opacity.stopAnimation(), [opacity]);
  const [explanation, setExplanation] = useState<BalanceSelection | null>(null);
  const historyResource = group.transactions ? 'transactions' : 'bills';
  const [search, setSearch] = useState(group.history?.[historyResource]?.query ?? ''), [searching, setSearching] = useState(!!group.history?.[historyResource]?.query);
  const historyWindow = group.history?.[historyResource];
  const expenses = group.read_mode === 'summary' ? group.expenses : group.expenses.filter(expense => group.expenses.length < 5 || `${expense.description} ${expense.notes}`.toLowerCase().includes(search.trim().toLowerCase()));
  const transfers = personalTransfers(group, selfId);
  const celebrateSettled = pending.length === 0 && accepted.balances?.[selfId] === '0';
  const rows: GroupTransaction[] = group.transactions ?? (group.read_mode === 'summary' ? expenses : [...expenses].reverse()).map(bill => ({ kind: 'bill', date: bill.date, bill }));
  const payments = personalSettlements(group, selfId);
  const searchable = rows.length >= 5 || !!(historyWindow?.next_cursor || historyWindow?.previous?.length || historyWindow?.query);
  const showSearch = searching;
  const searchRequest = useRef<AbortController | null>(null);
  useEffect(() => () => searchRequest.current?.abort(), []);
  async function runSearch(query: string) {
    searchRequest.current?.abort();
    const controller = new AbortController(); searchRequest.current = controller;
    try {
      const applied = await onHistoryPage?.(historyResource, 'search', query, controller.signal, accepted);
      if (controller.signal.aborted) return false;
      if (applied) list.current?.scrollToOffset({ offset: 0, animated: false });
      return applied ?? !historyWindow?.query;
    } catch { return false; }
    finally { if (searchRequest.current === controller) searchRequest.current = null; }
  }
  async function closeSearch() {
    Keyboard.dismiss();
    // A server filter must be removed successfully before hiding its controls.
    if ((historyWindow?.query || searchRequest.current) && !await runSearch('')) return;
    setSearch(''); setSearching(false);
  }
  const list = useRef<FlatList<GroupTransaction>>(null), frame = useRef<React.ComponentRef<typeof View>>(null);
  const [viewport, setViewport] = useState<{ x: number; y: number; width: number; height: number } | null>(null), [scrollEpoch, setScrollEpoch] = useState(0);
  const entries = useRef(new Map<string, ListEntry>()), [entryRevision, setEntryRevision] = useState(0);
  const transactionKey = (row: GroupTransaction) => row.kind === 'bill' ? `bill:${row.bill.id}` : `payment:${row.payment.id}`;
  const visible = useRef(onVisibleBills); visible.current = onVisibleBills;
  const viewable = useRef(({ viewableItems }: { viewableItems: { isViewable: boolean; index?: number | null; item: GroupTransaction }[] }) => {
    const shown = viewableItems.filter(row => row.isViewable).sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    const fresh = shown.filter(row => !entries.current.has(transactionKey(row.item)));
    fresh.forEach((row, index) => entries.current.set(transactionKey(row.item), { delay: Math.min(index, 6) * 35, played: false }));
    if (fresh.length) setEntryRevision(value => value + 1);
    visible.current?.(shown.filter(row => row.item.kind === 'bill').map(row => row.item.kind === 'bill' ? row.item.bill.id : ''));
  });
  const paging = useScrollPagination({ scope: `${pagingScope}|${group.version}|${historyResource}|${historyWindow?.query || ''}`,
    cursor: historyWindow?.next_cursor, enabled: active && online && !busy,
    load: signal => onHistoryPage?.(historyResource, 'next', undefined, signal, accepted) ?? Promise.resolve(false) });
  const visibility = noticeVisibility ? { ...noticeVisibility, viewport, scrollEpoch } : undefined;
  return <Animated.View ref={frame} role="region" accessibilityLabel={group.name} style={{ flex: 1, opacity }}>
    <FlatList ref={list} contentInsetAdjustmentBehavior="automatic" data={rows} extraData={entryRevision} nestedScrollEnabled scrollEventThrottle={100} onEndReachedThreshold={0.3}
      onLayout={event => { frame.current?.measureInWindow((x, y, width, height) => setViewport({ x, y, width, height })); }}
      onScroll={event => { setScrollEpoch(value => value + 1); }}
      keyboardShouldPersistTaps="handled" onViewableItemsChanged={viewable.current} onRefresh={onRefresh} refreshing={refreshing}
      keyExtractor={row => row.kind === 'bill' ? `bill:${row.bill.id}` : `payment:${row.payment.id}`}
      contentContainerStyle={[pageContentStyle, { gap: 0, paddingBottom: 120 }]} renderItem={({ item: row }) => <StaggerItem entry={entries.current.get(transactionKey(row))}>{row.kind === 'payment'
        ? <PaymentRow payment={row.payment} accepted={accepted} group={group} selfId={selfId} busy={busy} onPayment={onPayment} onPrefetchPayment={onPrefetchPayment} />
        : <BillTimelineRow categoryIcons={categoryIcons} expense={row.bill} group={group} selfId={selfId} busy={busy} onExpense={onExpense} onPrefetchBill={onPrefetchBill} noticeVisibility={group === accepted ? visibility : undefined} />}</StaggerItem>}
      ListHeaderComponent={<View style={s.content}>{header}
    {!!previewError && <Text>{previewError}</Text>}
    {group !== accepted && <Text style={ui.caption}>Balances show a pending preview.</Text>}
    {group.archived && <Text style={ui.notice}>Archived. Reopen in settings to make changes.</Text>}
    {!transfers.length && <Text style={celebrateSettled ? [ui.numeric, s.settled] : ui.caption}>{celebrateSettled ? '🎉 All settled' : 'All settled'}</Text>}
    {transfers.map(transfer => <PersonalTransferRow key={`${transfer.sender}:${transfer.recipient}`} transfer={transfer} group={group} selfId={selfId} disabled={busy || !!group.archived || pending.length > 0} onSettle={onSettle} onRemind={online ? onRemind : undefined} onExplain={(transfer, restoreFocus) => setExplanation({ group, accepted, commands: pending, selfId, transfer, restoreFocus, load: onLoadBalanceGroup })} />)}
    <View style={s.logHeading}>
      <SectionHeading style={[ui.caption, s.logCaption, s.flex]}>Bills and payments</SectionHeading>
      {searchable && !showSearch && <Button title="Search" icon="search" compact small accessibilityLabel="Search bills" onPress={() => setSearching(true)} />}
    </View>
      {showSearch && <BillSearch value={search} onChange={setSearch} onSearch={() => { void runSearch(search.trim()); }} onClose={() => { void closeSearch(); }} showSubmit={group.read_mode === 'summary'} busy={busy} autoFocus={searching} />}
</View>}
      ListEmptyComponent={<View style={s.empty}><Icon name="bill" size={32} /><Text style={ui.section}>{historyWindow?.next_cursor ? 'No matching records on this page.' : historyWindow?.query || search.trim() ? 'No matching bills' : 'No bills or payments yet'}</Text></View>}
      ListFooterComponent={<>
        <PagingFooter paging={paging} />
        {group.transactions === undefined && (!!payments.length || !!group.history?.settlements?.next_cursor) && <DetailDialog icon="payment" title="Payment records">
          <LegacyPayments group={group} accepted={accepted} selfId={selfId} busy={busy} onPayment={onPayment} onPrefetchPayment={onPrefetchPayment} onPage={onHistoryPage} scope={pagingScope} enabled={active && online} />
        </DetailDialog>}
      </>} />
    <BalanceExplanation selection={explanation} currentKey={balanceKey(incoming, pending)} onClose={() => setExplanation(null)} />
  </Animated.View>;
}
function RecordAttribution({ action, name }: { action: string; name?: string | null }) {
  const { ui } = useUI();
  return <Text style={ui.caption}>{name === undefined ? `${action === 'Added' ? 'Creator' : action === 'Marked paid' ? 'Recorder' : 'Reversal'} details not downloaded` : `${action} by ${name || 'unknown'}`}</Text>;
}

export function PaymentDetail({ payment, group, selfId, busy, canReverse, onReverse }: { payment: Settlement; group: Group; selfId: string; busy: boolean; canReverse: boolean; onReverse: () => void }) {
  const { palette: colors, ui } = useUI();
  const name = (id: string) => participantName(group.participants, selfId, id);
  const row = paymentPresentation(payment, selfId, name);
  const involved = payment.sender === selfId || payment.recipient === selfId;
  return <View role="region" accessibilityLabel={group.name} style={s.content}>
    <RecordSummary title={row.title} amount={payment.amount} amountColor={row.cashflow === '0' ? colors.text : balanceColor(row.cashflow, colors)}>
      <Text style={ui.caption}>{group.name} · {displayDate(payment.date)}{row.status ? ` · ${row.status}` : ''}</Text>
      {payment.provenance === 'pending_manual' ? <Text style={ui.caption}>Pending sync</Text> : <RecordAttribution action="Marked paid" name={payment.recorded_by_name} />}
      {payment.reversed && <RecordAttribution action="Reversed" name={payment.reversal?.actor_name} />}
    </RecordSummary>
    {payment.reversed ? <Text style={ui.notice}>This payment record was reversed.</Text>
      : <>{involved && <View style={s.section}><Button title="Reverse record" kind="danger" disabled={busy || !canReverse || group.archived || [payment.sender, payment.recipient].some(id => group.participants.find(person => person.id === id)?.removed)} onPress={onReverse} /></View>}</>}
  </View>;
}

export function ExpenseDetail({ categoryIcons = {}, noticeVisibility, expense, group, selfId, busy, canEdit, pending = false, onEdit, onReverse, onHistory, attachments, chat }: { categoryIcons?: ExpenseIcons; noticeVisibility?: NoticeVisibility; header?: React.ReactNode; expense: Expense; group: Group; selfId: string; busy: boolean; canEdit: boolean; pending?: boolean; onEdit: () => void; onReverse: () => void; onHistory?: () => void; attachments?: React.ReactNode; chat?: React.ReactNode }) {
  const { palette: colors, ui } = useUI();
  const hasCategory = !!expense.category && !['general', 'other'].includes(expense.category);
  const change = expenseBalanceChange(expense, selfId);
  const payers = group.participants.filter(person => BigInt(expense.paid[person.id] ?? '0') > 0n);
  const sharing = group.participants.filter(person => Object.hasOwn(expense.split.values, person.id));
  return <View role="region" accessibilityLabel={group.name} style={s.content}>
    <VisibleExpense groupId={group.id} expense={expense} visibility={(group.expenses.find(value => value.id === expense.id) ?? group.focused_expense) === expense ? noticeVisibility : undefined}><RecordSummary categoryText={hasCategory} category={expense.deleted ? null : expenseCategory({ ...expense, groupId: group.id, title: expense.description }, categoryIcons) ?? null} reversed={!!expense.deleted} title={expense.description} amount={expense.total}>
      <Text style={[ui.body, { color: balanceColor(change, colors) }]}>{billImpact(change)}</Text>
      <Text style={ui.caption}>{group.name} · {displayDate(expense.date)}</Text>
      {pending ? <Text style={ui.caption}>Saved on device. Pending sync.</Text> : <RecordAttribution action="Added" name={expense.added_by} />}
      {expense.deleted && <RecordAttribution action="Reversed" name={expense.reversal?.actor_name} />}
    </RecordSummary></VisibleExpense>
    {expense.deleted ? <Text style={ui.notice}>Bill record reversed. The original and its reversal are kept in history.</Text>
      : <Button title="Edit bill" icon="bill" kind="primary" disabled={busy || !canEdit} onPress={onEdit} />}
    {chat}
    {attachments}
    <BillPeople icon="pay" title="Who paid?" summary={`${payers.length} people`} inline={payers.length <= 1} disabled={busy}>
      {payers.map(person => <ParticipantAmountRow key={person.id} name={person.name} photo={person.profile_photo} amount={expense.paid[person.id] ?? '0'} />)}
    </BillPeople>
    <BillPeople icon="people" title="Split between" summary={`${sharing.length} people`} inline={sharing.length <= 1} disabled={busy}>
      <Text style={ui.caption}>{expense.split.mode === 'equal' ? 'Shared equally' : expense.split.mode === 'exact' ? 'Exact amounts' : expense.split.mode === 'percent' ? 'By percentage' : 'By shares'}</Text>
      {sharing.map(person => <ParticipantAmountRow key={person.id} name={person.name} photo={person.profile_photo} amount={expense.shares[person.id] ?? '0'} />)}
    </BillPeople>
    {(!!expense.notes || hasCategory) && <View style={s.section}>
      {!!expense.notes && <Text style={ui.body}>{expense.notes}</Text>}
      {hasCategory && <Text style={ui.caption}>Category: {expense.category}</Text>}
    </View>}
    {onHistory && <Button title="Version history" icon="history" kind="outlined" disabled={busy || pending} onPress={onHistory} />}
    {!expense.deleted && <Button title="Reverse record" kind="danger" disabled={busy || !canEdit || pending} onPress={onReverse} />}
    {!canEdit && <Text style={ui.caption}>{group.archived ? 'Reopen this group in settings before changing a bill.' : 'Send or discard saved changes before changing this bill.'}</Text>}
  </View>;
}
const s = StyleSheet.create({
  content: { gap: 10 },
  summary: { gap: 4, paddingVertical: 8 },
  section: { gap: 10, paddingVertical: 4 },
  trailing: { flexShrink: 1, maxWidth: '45%', alignItems: 'flex-end' },
  effect: { flexShrink: 1, fontSize: 14, lineHeight: 20 },
  balanceAmount: { fontSize: 16, lineHeight: 22 },
  logTitle: { fontSize: 14, lineHeight: 20 },
  logCaption: { fontSize: 12, lineHeight: 17 },
  edgeRow: { gap: 8, minHeight: 44, marginHorizontal: -16, paddingHorizontal: 16 },
  date: { minWidth: 40, flexShrink: 0, alignItems: 'center' },
  dateMonth: { fontSize: 11, lineHeight: 14 },
  dateDay: { fontSize: 14, lineHeight: 18 },
  paymentLine: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  paymentSentence: { flex: 1, minWidth: 0, fontWeight: '400' },
  logHeading: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44 },
  empty: { gap: 10, alignItems: 'center', paddingVertical: 20 },
  pressed: { opacity: 0.65 },
  settled: { fontSize: 36, lineHeight: 44 },
  search: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingBottom: 12 },
  searchField: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', borderRadius: 24, borderWidth: 1, paddingVertical: 0, paddingLeft: 12, paddingRight: 2 },
  searchInput: { flex: 1, minWidth: 0, backgroundColor: 'transparent', borderWidth: 0, paddingHorizontal: 8 },
  searchAction: { minWidth: 44, minHeight: 44, paddingHorizontal: 10, borderRadius: 22 },
  flex: { flex: 1, minWidth: 0 },
});
