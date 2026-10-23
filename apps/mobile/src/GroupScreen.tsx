import React, { useMemo, useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';
import { expenseBalanceChange, formatMoney } from './accounting';
import { Text } from 'react-native-paper';
import { personalSettlements, personalTransfers } from './personalBalances';
import { paymentPresentation } from './activityPresentation';
import { VisibleExpense } from './useExpenseNotices';
import type { NoticeVisibility } from './useExpenseNotices';
import type { BillRow, Command, Expense, Group, GroupTransaction, Settlement, HistoryResource } from './types';
import { Avatar, balanceColor, Button, Disclosure, Icon, radii, useUI } from './ui';
import type { Palette } from './ui';

type Transfer = { sender: string; recipient: string; amount: string };
type Props = {
  noticeVisibility?: NoticeVisibility;
  group: Group; accepted: Group; durable?: boolean; pending: Command[]; busy: boolean; selfId: string;
  onHistoryPage?: (resource: HistoryResource, direction: 'next' | 'previous' | 'search', query?: string) => void;
  onExpense: (expense: BillRow) => void; onPayment: (payment: Settlement) => void; onSettle: (transfer?: Transfer) => void;
  onReverse: (settlement: Settlement) => void;
  onSync: () => void; onDiscard: (command: Command) => void;
  onReview: (command: Command) => void;
  onConfirmReceipt: (attempt: NonNullable<Group['payment_attempts']>[number]) => void;
};
export const position = (name: string, value: string) => BigInt(value) > 0n ? `${name} ${name === 'You' ? 'are' : 'is'} owed ${formatMoney(value)}` : BigInt(value) < 0n ? `${name} ${name === 'You' ? 'owe' : 'owes'} ${formatMoney((-BigInt(value)).toString())}` : `${name} ${name === 'You' ? 'are' : 'is'} settled up`;
const displayDate = (value?: string | null) => {
  if (!value) return 'Date unavailable';
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
};
const billImpact = (value: string) => BigInt(value) === 0n ? 'No balance impact' : `Balance ${BigInt(value) > 0n ? '+' : '−'}${formatMoney((BigInt(value) < 0n ? -BigInt(value) : BigInt(value)).toString())}`;

export default function GroupScreen({ noticeVisibility, group, accepted, pending, durable = true, busy, selfId, onHistoryPage, onExpense, onPayment, onSettle, onSync, onDiscard, onReview, onConfirmReceipt }: Props) {
  const { palette: colors, ui, inputColors } = useUI();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const historyResource = group.transactions ? 'transactions' : 'bills';
  const [search, setSearch] = useState(group.history?.[historyResource]?.query ?? '');
  const expenses = group.read_mode === 'summary' ? group.expenses : group.expenses.filter(expense => group.expenses.length < 5 || `${expense.description} ${expense.notes}`.toLowerCase().includes(search.trim().toLowerCase()));
  const name = (id: string) => id === selfId ? 'You' : group.participants.find(person => person.id === id)?.name ?? 'Former member';
  const needsAttention = pending.some(command => command.state !== 'pending' || !!command.error);
  const receipts = (group.payment_attempts ?? []).filter(attempt =>
    attempt.recipient === selfId && ['reported', 'recorded', 'cancelled'].includes(attempt.state)
    && [attempt.sender, attempt.recipient].every(id => group.participants.some(person => person.id === id && !person.removed))
    && !group.settlements.some(settlement => settlement.reversed && (settlement.id === attempt.settlement_id || settlement.attempt_id === attempt.id)));
  const transfers = personalTransfers(group, selfId);
  const rows: GroupTransaction[] = group.transactions ?? (group.read_mode === 'summary' ? expenses : [...expenses].reverse()).map(bill => ({ kind: 'bill', date: bill.date, bill }));
  const pageNames = { bills: 'bills', transactions: 'bills & payments', activity: 'changes', settlements: 'payments', attempts: 'receipt requests' };
  const pages = (resource: HistoryResource) => group.history?.[resource] && <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>{!!group.history[resource]?.previous?.length && <Button title={`Newer ${pageNames[resource]}`} icon="back" disabled={busy} onPress={() => onHistoryPage?.(resource, 'previous')} />}{!!group.history[resource]?.next_cursor && <Button title={`Older ${pageNames[resource]}`} icon="next" disabled={busy} onPress={() => onHistoryPage?.(resource, 'next')} />}</View>;
  const searchField = <TextInput {...inputColors} accessibilityLabel="Search bills" placeholder="Find a bill by name or note" placeholderTextColor={colors.muted} value={search} onChangeText={setSearch} onSubmitEditing={() => onHistoryPage?.(historyResource, 'search', search.trim())} returnKeyType="search" style={[ui.input, { flex: 1, minWidth: 0 }]} />;
  const paymentRow = (payment: Settlement) => {
    const isAccepted = accepted.settlements.some(record => record.id === payment.id) || accepted.transactions?.some(record => record.kind === 'payment' && record.payment.id === payment.id);
    if (!isAccepted) return null;
    const presentation = paymentPresentation(payment, selfId, name);
    return <Pressable key={`payment:${payment.id}`} accessibilityRole="button" accessibilityLabel={`${presentation.title}, ${formatMoney(payment.amount)}, ${presentation.status}, ${displayDate(payment.date)}`} disabled={busy} style={({ pressed }) => [ui.row, pressed && s.pressed]} onPress={() => onPayment(payment)}>
      <View style={s.billMark}><Icon name="pay" /></View>
      <View style={ui.rowBody}>
        <Text numberOfLines={1} ellipsizeMode="tail" style={ui.rowTitle}>{presentation.title}</Text>
        <Text style={ui.rowSub}>{payment.reversed ? 'Record reversed · No bank refund' : presentation.status}</Text>
        <Text style={ui.rowSub}>{displayDate(payment.date)}</Text>
      </View>
      <View style={s.trailing}><Text style={[s.amount, { color: presentation.cashflow === '0' ? colors.text : balanceColor(presentation.cashflow, colors) }]}>{formatMoney(payment.amount)}</Text><Icon name="next" size={18} color={colors.muted} /></View>
    </Pressable>;
  };
  return <View style={s.content}>
    {group.archived && <Text style={ui.notice}>Archived. Reopen in settings to make changes.{receipts.length > 0 ? ' You can still confirm money received.' : ''}</Text>}
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
    {!transfers.length && <Text style={ui.caption}>All settled</Text>}
    {transfers.map(transfer => {
      const outgoing = transfer.sender === selfId, counterpart = outgoing ? transfer.recipient : transfer.sender;
      const person = group.participants.find(person => person.id === counterpart), removed = person?.removed;
      const action = outgoing && person?.user_id != null && !!person.payment_profile?.vpa ? 'Pay' : 'Record';
      return <View key={`${transfer.sender}:${transfer.recipient}`} style={ui.row}>
        <Avatar name={name(counterpart)} />
        <View style={ui.rowBody}><Text numberOfLines={1} ellipsizeMode="tail" style={ui.rowTitle}>{name(counterpart)}</Text><Text style={ui.rowSub}>{outgoing ? 'You owe' : 'Owes you'}{removed ? ' · Removed' : ''}</Text></View>
        <Text style={[s.amount, { color: outgoing ? colors.negative : colors.positive }]}>{formatMoney(transfer.amount)}</Text>
        <Button title={action} kind="text" accessibilityLabel={`${action} payment ${outgoing ? 'to' : 'from'} ${name(counterpart)}, ${formatMoney(transfer.amount)}`} disabled={busy || group.archived || pending.length > 0 || !!removed} onPress={() => onSettle(transfer)} />
      </View>;
    })}
    <Text style={ui.caption}>Bills and payments</Text>
      {(rows.length >= 5 || !!(group.history?.[historyResource]?.next_cursor || group.history?.[historyResource]?.previous?.length || group.history?.[historyResource]?.query)) && <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>{searchField}{group.read_mode === 'summary' && <Button title="Search" disabled={busy} onPress={() => onHistoryPage?.(historyResource, 'search', search.trim())} />}</View>}
      {!rows.length && <View style={s.empty}>
        <Icon name="bill" size={32} />
        <Text style={ui.section}>{group.history?.[historyResource]?.query || (group.read_mode !== 'summary' && search.trim()) ? 'No matching bills' : 'No bills or payments yet'}</Text>
      </View>}
      {rows.map(row => {
        if (row.kind === 'payment') {
          return paymentRow(row.payment);
        }
        const expense = row.bill;
        const change = expenseBalanceChange(expense, selfId);
        const payers = Object.entries(expense.paid).filter(([, amount]) => BigInt(amount) > 0n).map(([id, amount]) => `${name(id)} paid ${formatMoney(amount)}`).join(', ');
        return <VisibleExpense key={`bill:${expense.id}`} groupId={group.id} expense={expense} visibility={group === accepted ? noticeVisibility : undefined}><Pressable accessibilityRole="button" accessibilityLabel={`${expense.description}, total ${formatMoney(expense.total)}, ${billImpact(change)}, ${payers}, ${displayDate(expense.date)}${expense.deleted ? ', deleted' : ''}`} disabled={busy} style={({ pressed }) => [ui.row, pressed && s.pressed]} onPress={() => onExpense(expense)}>
        <View style={s.billMark}><Icon name="bill" /></View>
        <View style={[ui.rowBody, s.flex]}>
          <Text numberOfLines={1} ellipsizeMode="tail" style={ui.rowTitle}>{expense.description}{expense.deleted ? ' · Deleted' : ''}</Text>
          <Text style={[ui.rowSub, { color: balanceColor(change, colors) }]}>{billImpact(change)}</Text>
          <Text style={ui.rowSub}>{displayDate(expense.date)}</Text>
        </View>
        <View style={s.trailing}><Text style={s.amount}>{formatMoney(expense.total)}</Text><Icon name="next" size={18} color={colors.muted} /></View>
      </Pressable></VisibleExpense>;
      })}
      {group.transactions === undefined && (!!personalSettlements(group, selfId).length || !!group.history?.settlements?.next_cursor || !!group.history?.settlements?.previous?.length) && <Disclosure title="Payment records">
        {personalSettlements(group, selfId).map(paymentRow)}
        {pages('settlements')}
      </Disclosure>}
      {pages(historyResource)}
  </View>;
}

export function PaymentDetail({ payment, group, selfId, busy, canReverse, onReverse }: { payment: Settlement; group: Group; selfId: string; busy: boolean; canReverse: boolean; onReverse: () => void }) {
  const { palette: colors, ui } = useUI();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const name = (id: string) => id === selfId ? 'You' : group.participants.find(person => person.id === id)?.name ?? 'Former member';
  const row = paymentPresentation(payment, selfId, name);
  const involved = payment.sender === selfId || payment.recipient === selfId;
  return <View style={s.content}>
    <View style={s.summary}>
      <Text style={ui.section}>{row.title}</Text>
      <Text style={[ui.numeric, { color: row.cashflow === '0' ? colors.text : balanceColor(row.cashflow, colors) }]}>{formatMoney(payment.amount)}</Text>
      <Text style={ui.caption}>{group.name} · {displayDate(payment.date)} · {row.status}</Text>
    </View>
    {payment.reversed ? <Text style={ui.notice}>This payment record was reversed. No bank transfer was reversed.</Text>
      : <>{involved && <Disclosure title="Payment options"><Button title="Reverse record" kind="danger" disabled={busy || !canReverse || group.archived || [payment.sender, payment.recipient].some(id => group.participants.find(person => person.id === id)?.removed)} onPress={onReverse} /><Text style={ui.caption}>Reverses this record, not a bank transfer.</Text></Disclosure>}</>}
  </View>;
}

export function ExpenseDetail({ noticeVisibility, expense, group, selfId, busy, canEdit, onEdit, onDelete, onRestore }: { noticeVisibility?: NoticeVisibility; expense: Expense; group: Group; selfId: string; busy: boolean; canEdit: boolean; onEdit: () => void; onDelete: () => void; onRestore: () => void }) {
  const { palette: colors, ui } = useUI();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const hasCategory = !!expense.category && !['general', 'other'].includes(expense.category);
  const change = expenseBalanceChange(expense, selfId);
  return <View style={s.content}>
    <VisibleExpense groupId={group.id} expense={expense} visibility={(group.expenses.find(value => value.id === expense.id) ?? group.focused_expense) === expense ? noticeVisibility : undefined}><View style={s.summary}>
      <Text style={ui.section}>{expense.description}</Text>
      <Text style={ui.numeric}>{formatMoney(expense.total)}</Text>
      <Text style={[ui.body, { color: balanceColor(change, colors) }]}>{billImpact(change)}</Text>
      <Text style={ui.caption}>{group.name} · {displayDate(expense.date)}</Text>
    </View></VisibleExpense>
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
  content: { gap: 10 },
  summary: { gap: 4, paddingVertical: 8 },
  section: { gap: 10, paddingVertical: 4 },
  receipt: { gap: 12, padding: 12, borderRadius: radii.surface, backgroundColor: colors.surface },
  billMark: { width: 36, height: 36, borderRadius: radii.control, backgroundColor: colors.soft, alignItems: 'center', justifyContent: 'center' },
  trailing: { flexShrink: 0, gap: 4, alignItems: 'flex-end' },
  amount: { color: colors.text, fontSize: 17, lineHeight: 24, fontWeight: '600', fontVariant: ['tabular-nums'], flexShrink: 0, textAlign: 'right' },
  empty: { gap: 10, alignItems: 'center', paddingVertical: 20 },
  pressed: { opacity: 0.65 },
  flex: { flex: 1, minWidth: 0 },
});
