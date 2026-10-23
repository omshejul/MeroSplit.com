import React, { useMemo, useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';
import { expenseBalanceChange, formatMoney, settlementCashflow } from './accounting';
import { Text } from 'react-native-paper';
import type { Command, Expense, Group, Settlement, HistoryResource } from './types';
import { Avatar, balanceColor, Button, Disclosure, Icon, radii, useUI } from './ui';
import type { Palette } from './ui';

type Transfer = { sender: string; recipient: string; amount: string };
type Props = {
  group: Group; accepted: Group; durable?: boolean; pending: Command[]; busy: boolean; selfId: string;
  onHistoryPage?: (resource: HistoryResource, direction: 'next' | 'previous' | 'search', query?: string) => void;
  onAdd: () => void; onExpense: (expense: Expense) => void; onSettle: (transfer?: Transfer) => void;
  onReverse: (settlement: Settlement) => void;
  onSync: () => void; onDiscard: (command: Command) => void;
  onReview: (command: Command) => void;
  onConfirmReceipt: (attempt: NonNullable<Group['payment_attempts']>[number]) => void;
};
export const position = (name: string, value: string) => BigInt(value) > 0n ? `${name} ${name === 'You' ? 'are' : 'is'} owed ${formatMoney(value)}` : BigInt(value) < 0n ? `${name} ${name === 'You' ? 'owe' : 'owes'} ${formatMoney((-BigInt(value)).toString())}` : `${name} ${name === 'You' ? 'are' : 'is'} settled up`;
const displayDate = (value: string) => {
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
};
const billImpact = (value: string) => BigInt(value) === 0n ? 'No balance impact' : `Balance ${BigInt(value) > 0n ? '+' : '−'}${formatMoney((BigInt(value) < 0n ? -BigInt(value) : BigInt(value)).toString())}`;

export default function GroupScreen({ group, accepted, pending, durable = true, busy, selfId, onHistoryPage, onAdd, onExpense, onSettle, onReverse, onSync, onDiscard, onReview, onConfirmReceipt }: Props) {
  const { palette: colors, ui, inputColors } = useUI();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const [section, setSection] = useState('Bills');
  const [search, setSearch] = useState(group.history?.bills.query ?? '');
  const expenses = group.read_mode === 'summary' ? group.expenses : group.expenses.filter(expense => group.expenses.length < 5 || `${expense.description} ${expense.notes}`.toLowerCase().includes(search.trim().toLowerCase()));
  const name = (id: string) => id === selfId ? 'You' : group.participants.find(person => person.id === id)?.name ?? 'Former member';
  const balance = BigInt(group.balances[selfId] ?? '0');
  const needsAttention = pending.some(command => command.state !== 'pending' || !!command.error);
  const receipts = (group.payment_attempts ?? []).filter(attempt =>
    attempt.recipient === selfId && ['reported', 'recorded', 'cancelled'].includes(attempt.state)
    && [attempt.sender, attempt.recipient].every(id => group.participants.some(person => person.id === id && !person.removed))
    && !group.settlements.some(settlement => settlement.reversed && (settlement.id === attempt.settlement_id || settlement.attempt_id === attempt.id)));
  const transfers = group.transfers.filter(transfer => BigInt(transfer.amount) > 0n && transfer.sender !== transfer.recipient && [transfer.sender, transfer.recipient].every(id => group.participants.some(person => person.id === id && !person.removed)));
  const purchases = group.expenses.filter(expense => !expense.deleted);
  const spending = group.read_mode === 'summary' && group.totals ? group.totals.spending : purchases.reduce((total, expense) => total + BigInt(expense.total), 0n).toString();
  const pageNames = { bills: 'bills', activity: 'changes', settlements: 'payments', attempts: 'receipt requests' };
  const pages = (resource: HistoryResource) => group.history && <View style={{ flexDirection: 'row', gap: 8 }}>{!!group.history[resource].previous?.length && <Button title={`Newer ${pageNames[resource]}`} icon="back" disabled={busy} onPress={() => onHistoryPage?.(resource, 'previous')} />}{!!group.history[resource].next_cursor && <Button title={`Older ${pageNames[resource]}`} icon="next" disabled={busy} onPress={() => onHistoryPage?.(resource, 'next')} />}</View>;
  const searchField = <TextInput {...inputColors} accessibilityLabel="Search bills" placeholder="Find a bill by name or note" placeholderTextColor={colors.muted} value={search} onChangeText={setSearch} onSubmitEditing={() => onHistoryPage?.('bills', 'search', search.trim())} returnKeyType="search" style={[ui.input, { flex: 1, minWidth: 0 }]} />;
  return <View style={s.content}>
    <View style={s.summary}>
      <Text style={ui.caption}>{balance > 0n ? 'You are owed' : balance < 0n ? 'You owe' : 'Your balance'}</Text>
      <Text style={[ui.numeric, { color: balanceColor(balance, colors) }]}>{balance === 0n ? 'All settled' : formatMoney((balance < 0n ? -balance : balance).toString())}</Text>
      {pending.length > 0 && <Text style={ui.caption}>{group !== accepted ? 'Includes unsynced changes' : 'Accepted balance. Saved changes need review.'}</Text>}
    </View>
    {group.archived && <Text style={ui.notice}>Archived. Reopen in settings to make changes.{receipts.length > 0 ? ' You can still confirm money received.' : ''}</Text>}
    <Button title="Add a bill" icon="add" kind="primary" disabled={busy || group.archived} onPress={onAdd} />
    {pending.length > 0 && <View style={s.section}>
      <Text style={[ui.notice, ui.warning]}>{needsAttention ? 'Some changes need your attention.' : durable ? 'Waiting to sync.' : 'Not confirmed. Keep this tab open and reconnect.'}</Text>
      <Disclosure title={`${pending.length} ${durable ? 'saved' : 'temporary'} ${pending.length === 1 ? 'change' : 'changes'}`} initialOpen={needsAttention}>
        <Button title="Retry sync" disabled={busy} onPress={onSync} />
        {pending.map(command => <View key={command.command_id} style={s.section}>
          <Text style={ui.rowTitle}>{String(command.body.description ?? 'Group change')}</Text>
          <Text style={[ui.caption, { color: colors.warning }]}>{command.state === 'pending' ? 'Waiting to sync' : command.error ?? 'Needs review'}</Text>
          {command.state !== 'pending' && ['POST', 'PUT'].includes(command.method) && command.path.includes('/expenses') && <Button title="Review my saved change" disabled={busy} onPress={() => onReview(command)} />}
          <Button kind="text" title={command.path === '/groups' ? 'Discard unsent group' : 'Discard this saved change'} disabled={busy} onPress={() => onDiscard(command)} />
        </View>)}
      </Disclosure>
    </View>}
    {receipts.map(attempt => <View key={attempt.id} style={s.receipt}>
      <Text style={ui.section}>Did you get {formatMoney(attempt.recorded_amount ?? attempt.amount)} from {name(attempt.sender)}?</Text>
      <Text style={[ui.caption, { color: colors.warning }]}>{group.name}. {attempt.state === 'cancelled' ? 'The earlier report was cancelled. ' : ''}Check your bank or UPI app before confirming.</Text>
      <Button title={`Yes, I got ${formatMoney(attempt.recorded_amount ?? attempt.amount)}`} icon="check" disabled={busy || pending.length > 0} onPress={() => onConfirmReceipt(attempt)} />
    </View>)}
    {group.history?.attempts && <>{pages('attempts')}</>}
    <View style={s.tabs} accessibilityRole="tablist">
      {['Bills', 'Balances'].map(value => <Pressable key={value} accessibilityRole="tab" accessibilityState={{ selected: section === value }} onPress={() => setSection(value)} style={[s.tab, section === value && s.selectedTab]}>
        <Text style={[s.tabText, section === value && s.selectedTabText]}>{value}</Text>
      </Pressable>)}
    </View>
    {section === 'Bills' && <>
      {(group.expenses.length >= 5 || !!(group.history?.bills.next_cursor || group.history?.bills.previous?.length || group.history?.bills.query)) && <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>{searchField}{group.read_mode === 'summary' && <Button title="Search" disabled={busy} onPress={() => onHistoryPage?.('bills', 'search', search.trim())} />}</View>}
      {!expenses.length && <View style={s.empty}>
        <Icon name="bill" size={32} />
        <Text style={ui.section}>{search.trim() ? 'No matching bills' : 'No bills yet'}</Text>
      </View>}
      {(group.read_mode === 'summary' ? expenses : [...expenses].reverse()).map(expense => {
        const change = expenseBalanceChange(expense, selfId);
        const payers = Object.entries(expense.paid).filter(([, amount]) => BigInt(amount) > 0n).map(([id, amount]) => `${name(id)} paid ${formatMoney(amount)}`).join(', ');
        return <Pressable accessibilityRole="button" accessibilityLabel={`${expense.description}, total ${formatMoney(expense.total)}, ${billImpact(change)}, ${payers}, ${displayDate(expense.date)}${expense.deleted ? ', deleted' : ''}`} key={expense.id} style={({ pressed }) => [ui.row, pressed && s.pressed]} onPress={() => onExpense(expense)}>
        <View style={s.billMark}><Icon name="bill" /></View>
        <View style={[ui.rowBody, s.flex]}>
          <Text numberOfLines={1} ellipsizeMode="tail" style={ui.rowTitle}>{expense.description}{expense.deleted ? ' · Deleted' : ''}</Text>
          <Text style={[ui.rowSub, { color: balanceColor(change, colors) }]}>{billImpact(change)}</Text>
          <Text style={ui.rowSub}>{displayDate(expense.date)}</Text>
        </View>
        <View style={s.trailing}><Text style={s.amount}>{formatMoney(expense.total)}</Text><Icon name="next" size={18} color={colors.muted} /></View>
      </Pressable>;
      })}
      {(group.settlements.length > 0 || group.history?.settlements.previous?.length || group.history?.settlements.next_cursor) ? <Disclosure title="Payment records">
        {group.settlements.map(payment => {
          const isAccepted = accepted.settlements.some(record => record.id === payment.id);
          const cashflow = isAccepted ? BigInt(settlementCashflow(payment, selfId)) : 0n;
          const confirmed = payment.method === 'recipient_confirmed' || payment.method === 'manual_then_confirmed';
          const direction = cashflow < 0n ? confirmed ? 'Sent' : 'Recorded outgoing' : cashflow > 0n ? confirmed ? 'Received' : 'Recorded incoming' : '';
          return <View key={payment.id} style={s.payment}>
          <Text style={ui.rowTitle}>{name(payment.sender)} to {name(payment.recipient)}</Text>
          <Text style={[s.amount, { color: balanceColor(cashflow, colors) }]}>{direction ? `${direction} ` : ''}{formatMoney(payment.amount)}</Text>
          <Text style={[ui.caption, { color: colors.muted }]}>{!isAccepted ? 'Waiting to sync' : payment.reversed ? 'Record reversed' : confirmed ? 'Recipient confirmed' : 'Receipt unconfirmed'}</Text>
          {!payment.reversed && <Button title="Reverse record" accessibilityLabel={`Reverse ${formatMoney(payment.amount)} payment from ${name(payment.sender)} to ${name(payment.recipient)}`} kind="text" disabled={busy || group.archived || pending.length > 0} onPress={() => onReverse(payment)} />}
        </View>;
        })}
        {pages('settlements')}
      </Disclosure> : null}
      {pages('bills')}
    </>}
    {section === 'Balances' && <>
      {group.participants.map(person => <View key={person.id} style={ui.row}>
        <Avatar name={name(person.id)} />
        <View style={ui.rowBody}>
          <Text style={ui.rowTitle}>{name(person.id)}{person.removed ? ' · Removed' : ''}</Text>
          <Text style={[ui.rowSub, { color: balanceColor(group.balances[person.id] ?? '0', colors) }]}>{position(name(person.id), group.balances[person.id] ?? '0')}</Text>
          {pending.length > 0 && <Text style={ui.rowSub}>Synced: {position(name(person.id), accepted.balances[person.id] ?? '0')}</Text>}
        </View>
      </View>)}
      <View style={s.section}>
        <Text style={ui.section}>Simplify</Text>
        <Text style={ui.caption}>Fewer payments. Same balances.</Text>
        {transfers.map((transfer, index) => <View key={index} style={s.transfer}>
          <Text style={[ui.rowTitle, { color: transfer.sender === selfId ? colors.negative : transfer.recipient === selfId ? colors.positive : colors.text }]}>{name(transfer.sender)} {transfer.sender === selfId ? 'owe' : 'owes'} {name(transfer.recipient)} {formatMoney(transfer.amount)}</Text>
          <Button title={`Record ${formatMoney(transfer.amount)}`} accessibilityLabel={`Record ${formatMoney(transfer.amount)} from ${name(transfer.sender)} to ${name(transfer.recipient)}`} icon="pay" disabled={busy || group.archived} onPress={() => onSettle(transfer)} />
        </View>)}
        {!transfers.length && <Text style={[ui.body, ui.success]}>Everyone is settled up.</Text>}
      </View>
      <Disclosure title={pending.length && group.read_mode === 'summary' ? 'Accepted totals' : 'Totals'}>
      <View style={s.summary}><Text style={ui.caption}>Total spending</Text><Text style={ui.numeric}>{formatMoney(spending)}</Text></View>
      {group.participants.map(person => <View key={person.id} style={ui.row}>
        <Avatar name={name(person.id)} />
        <View style={ui.rowBody}>
          <Text style={ui.rowTitle}>{name(person.id)}{person.removed ? ' · Removed' : ''}</Text>
          <Text style={ui.rowSub}>Paid {formatMoney(group.read_mode === 'summary' && group.totals ? group.totals.paid[person.id] ?? '0' : purchases.reduce((total, expense) => total + BigInt(expense.paid[person.id] ?? '0'), 0n).toString())}</Text>
          <Text style={ui.rowSub}>Share {formatMoney(group.read_mode === 'summary' && group.totals ? group.totals.shares[person.id] ?? '0' : purchases.reduce((total, expense) => total + BigInt(expense.shares[person.id] ?? '0'), 0n).toString())}</Text>
        </View>
      </View>)}
      </Disclosure>
    </>}
  </View>;
}

export function ExpenseDetail({ expense, group, selfId, busy, canEdit, onEdit, onDelete, onRestore }: { expense: Expense; group: Group; selfId: string; busy: boolean; canEdit: boolean; onEdit: () => void; onDelete: () => void; onRestore: () => void }) {
  const { palette: colors, ui } = useUI();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const hasCategory = !!expense.category && !['general', 'other'].includes(expense.category);
  const change = expenseBalanceChange(expense, selfId);
  return <View style={s.content}>
    <View style={s.summary}>
      <Text style={ui.section}>{expense.description}</Text>
      <Text style={ui.numeric}>{formatMoney(expense.total)}</Text>
      <Text style={[ui.body, { color: balanceColor(change, colors) }]}>{billImpact(change)}</Text>
      <Text style={ui.caption}>{group.name} · {displayDate(expense.date)}</Text>
    </View>
    {expense.deleted ? <>
      <Text style={ui.notice}>Deleted bill</Text>
      <Button title="Restore bill" icon="history" kind="primary" disabled={busy || !canEdit} onPress={onRestore} />
    </> : <Button title="Edit bill" icon="bill" kind="primary" disabled={busy || !canEdit} onPress={onEdit} />}
    <View style={s.section}>
      <Text style={ui.section}>Who paid?</Text>
      {group.participants.filter(person => BigInt(expense.paid[person.id] ?? '0') > 0n).map(person => <View key={person.id} style={ui.row}>
        <Avatar name={person.name} /><Text numberOfLines={1} ellipsizeMode="tail" accessibilityLabel={person.name} style={[ui.rowTitle, s.flex]}>{person.name}</Text><Text style={s.amount}>{formatMoney(expense.paid[person.id] ?? '0')}</Text>
      </View>)}
    </View>
    <View style={s.section}>
      <Text style={ui.section}>Split between</Text>
      <Text style={ui.caption}>{expense.split.mode === 'equal' ? 'Shared equally' : expense.split.mode === 'exact' ? 'Exact amounts' : expense.split.mode === 'percent' ? 'By percentage' : 'By shares'}</Text>
      {group.participants.filter(person => Object.hasOwn(expense.split.values, person.id)).map(person => <View key={person.id} style={ui.row}>
        <Avatar name={person.name} /><Text numberOfLines={1} ellipsizeMode="tail" accessibilityLabel={person.name} style={[ui.rowTitle, s.flex]}>{person.name}</Text><Text style={s.amount}>{formatMoney(expense.shares[person.id] ?? '0')}</Text>
      </View>)}
    </View>
    {(!!expense.notes || hasCategory) && <Disclosure title="Notes and details">
      {!!expense.notes && <Text style={ui.body}>{expense.notes}</Text>}
      {hasCategory && <Text style={ui.caption}>Category: {expense.category}</Text>}
    </Disclosure>}
    {!expense.deleted && <Disclosure title="Bill options">
      <Button title="Delete bill" kind="danger" disabled={busy || !canEdit} onPress={onDelete} />
    </Disclosure>}
    {!canEdit && <Text style={ui.caption}>{group.archived ? 'Reopen this group in settings before changing a bill.' : 'Send or discard saved changes before changing this bill.'}</Text>}
  </View>;
}
const makeStyles = (colors: Palette) => StyleSheet.create({
  content: { gap: 12 },
  summary: { gap: 4, paddingVertical: 8 },
  section: { gap: 10, paddingVertical: 4 },
  receipt: { gap: 12, padding: 12, borderRadius: radii.surface, backgroundColor: colors.surface },
  tabs: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, padding: 4, borderRadius: radii.surface, backgroundColor: colors.surface },
  tab: { flex: 1, flexBasis: 80, minHeight: 48, borderRadius: radii.control, paddingHorizontal: 10, paddingVertical: 12, alignItems: 'center', justifyContent: 'center' },
  selectedTab: { backgroundColor: colors.soft },
  tabText: { color: colors.muted, fontSize: 15, lineHeight: 21, fontWeight: '500', textAlign: 'center' },
  selectedTabText: { color: colors.accent, fontWeight: '600' },
  billMark: { width: 36, height: 36, borderRadius: radii.control, backgroundColor: colors.soft, alignItems: 'center', justifyContent: 'center' },
  trailing: { flexShrink: 0, gap: 4, alignItems: 'flex-end' },
  amount: { color: colors.text, fontSize: 17, lineHeight: 24, fontWeight: '600', fontVariant: ['tabular-nums'], flexShrink: 0, textAlign: 'right' },
  payment: { gap: 6, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  transfer: { gap: 8, paddingVertical: 10 },
  empty: { gap: 10, alignItems: 'center', paddingVertical: 20 },
  pressed: { opacity: 0.65 },
  flex: { flex: 1, minWidth: 0 },
});
