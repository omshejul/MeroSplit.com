import React, { useState } from 'react';
import BillPeople from './BillPeople';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';
import { expenseBalanceChange, formatMoney } from './accounting';
import { Text } from 'react-native-paper';
import { personalSettlements, personalTransfers } from './personalBalances';
import { paymentPresentation } from './activityPresentation';
import { VisibleExpense } from './useExpenseNotices';
import type { NoticeVisibility } from './useExpenseNotices';
import type { BillRow, Command, Expense, Group, GroupTransaction, Participant, Settlement, HistoryResource, HistoryWindow } from './types';
import { SectionHeading, AmountText, Avatar, balanceColor, Button, Disclosure, Icon, IconBadge, radii, useUI } from './ui';

type Transfer = { sender: string; recipient: string; amount: string };
type ReceiptAttempt = NonNullable<Group['payment_attempts']>[number];
type Props = {
  noticeVisibility?: NoticeVisibility;
  group: Group; accepted: Group; durable?: boolean; pending: Command[]; busy: boolean; selfId: string;
  onHistoryPage?: (resource: HistoryResource, direction: 'next' | 'previous' | 'search', query?: string) => void;
  onExpense: (expense: BillRow) => void; onPayment: (payment: Settlement) => void; onSettle: (transfer?: Transfer) => void;
  onReverse: (settlement: Settlement) => void;
  onSync: () => void; onDiscard: (command: Command) => void;
  onReview: (command: Command) => void;
  onConfirmReceipt: (attempt: ReceiptAttempt) => void;
};
export const position = (name: string, value: string) => BigInt(value) > 0n ? `${name} ${name === 'You' ? 'are' : 'is'} owed ${formatMoney(value)}` : BigInt(value) < 0n ? `${name} ${name === 'You' ? 'owe' : 'owes'} ${formatMoney((-BigInt(value)).toString())}` : `${name} ${name === 'You' ? 'are' : 'is'} settled up`;
const displayDate = (value?: string | null) => {
  if (!value) return 'Date unavailable';
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
};
const billImpact = (value: string) => BigInt(value) === 0n ? 'No balance impact' : `Balance ${BigInt(value) > 0n ? '+' : '−'}${formatMoney((BigInt(value) < 0n ? -BigInt(value) : BigInt(value)).toString())}`;
const participantName = (participants: Participant[], selfId: string, id: string) => id === selfId ? 'You' : participants.find(person => person.id === id)?.name ?? 'Former member';
const pageNames = { bills: 'bills', transactions: 'bills & payments', activity: 'changes', settlements: 'payments', attempts: 'receipt requests' };

function HistoryPages({ history, resource, busy, onPage }: { history?: HistoryWindow; resource: HistoryResource; busy: boolean; onPage: Props['onHistoryPage'] }) {
  if (!history) return null;
  return <View style={historyPageStyle}>
    {!!history.previous?.length && <Button title={`Newer ${pageNames[resource]}`} icon="back" disabled={busy} onPress={() => onPage?.(resource, 'previous')} />}
    {!!history.next_cursor && <Button title={`Older ${pageNames[resource]}`} icon="next" disabled={busy} onPress={() => onPage?.(resource, 'next')} />}
  </View>;
}

function PendingChangeRow({ command, busy, onReview, onDiscard }: { command: Command; busy: boolean; onReview: Props['onReview']; onDiscard: Props['onDiscard'] }) {
  const { palette: colors, ui } = useUI();
  return <View style={s.section}>
    <Text style={ui.rowTitle}>{String(command.body.description ?? 'Group change')}</Text>
    <Text style={[ui.caption, { color: colors.warning }]}>{command.state === 'pending' ? 'Waiting to sync' : command.error ?? 'Needs review'}</Text>
    {command.state !== 'pending' && ['POST', 'PUT'].includes(command.method) && /\/expenses(?:\/[^/]+)?$/.test(command.path) && <Button title="Review my saved change" disabled={busy} onPress={() => onReview(command)} />}
    <Button kind="text" title={command.path === '/groups' ? 'Discard unsent group' : 'Discard this saved change'} disabled={busy} onPress={() => onDiscard(command)} />
  </View>;
}

function ReceiptRequest({ attempt, groupName, senderName, disabled, onConfirm }: { attempt: ReceiptAttempt; groupName: string; senderName: string; disabled: boolean; onConfirm: Props['onConfirmReceipt'] }) {
  const { palette: colors, ui } = useUI();
  return <View style={[s.receipt, { backgroundColor: colors.surface }]}>
    <Text style={ui.section}>Did you get {formatMoney(attempt.recorded_amount ?? attempt.amount)} from {senderName}?</Text>
    <Text style={[ui.caption, { color: colors.warning }]}>{groupName}. {attempt.state === 'cancelled' ? 'The earlier report was cancelled. ' : ''}Check your bank or UPI app before confirming.</Text>
    <Button title={`Yes, I got ${formatMoney(attempt.recorded_amount ?? attempt.amount)}`} icon="check" disabled={disabled} onPress={() => onConfirm(attempt)} />
  </View>;
}

function PersonalTransferRow({ transfer, group, selfId, disabled, onSettle }: { transfer: Transfer; group: Group; selfId: string; disabled: boolean; onSettle: Props['onSettle'] }) {
  const { palette: colors, ui } = useUI();
  const outgoing = transfer.sender === selfId, counterpart = outgoing ? transfer.recipient : transfer.sender;
  const person = group.participants.find(person => person.id === counterpart), removed = person?.removed;
  const name = participantName(group.participants, selfId, counterpart);
  const action = outgoing && person?.user_id != null && !!person.payment_profile?.vpa ? 'Pay' : 'Record';
  return <View style={ui.row}>
    <Avatar name={name} />
    <View style={ui.rowBody}><Text numberOfLines={1} ellipsizeMode="tail" style={ui.rowTitle}>{name}</Text><Text style={ui.rowSub}>{outgoing ? 'You owe' : 'Owes you'}{removed ? ' · Removed' : ''}</Text></View>
    <AmountText amount={transfer.amount} style={{ color: outgoing ? colors.negative : colors.positive }} />
    <Button title={action} kind="text" accessibilityLabel={`${action} payment ${outgoing ? 'to' : 'from'} ${name}, ${formatMoney(transfer.amount)}`} disabled={disabled || !!removed} onPress={() => onSettle(transfer)} />
  </View>;
}

function TransactionRow({ icon, title, amount, cashflow, label, busy, onPress, children }: {
  icon: 'bill' | 'payment'; title: string; amount: string; cashflow?: string; label: string; busy: boolean; onPress: () => void; children: React.ReactNode;
}) {
  const { palette: colors, ui } = useUI();
  return <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={busy} style={({ pressed }) => [ui.row, pressed && s.pressed]} onPress={onPress}>
    <IconBadge name={icon} />
    <View style={ui.rowBody}>
      <Text numberOfLines={1} ellipsizeMode="tail" style={ui.rowTitle}>{title}</Text>
      {children}
    </View>
    <View style={s.trailing}><AmountText amount={amount} style={{ color: cashflow === undefined || cashflow === '0' ? colors.text : balanceColor(cashflow, colors) }} /><Icon name="next" size={18} color={colors.muted} /></View>
  </Pressable>;
}

function PaymentRow({ payment, accepted, group, selfId, busy, onPayment }: Pick<Props, 'accepted' | 'group' | 'selfId' | 'busy' | 'onPayment'> & { payment: Settlement }) {
  const { palette: colors, ui } = useUI();
  const isAccepted = accepted.settlements.some(record => record.id === payment.id) || accepted.transactions?.some(record => record.kind === 'payment' && record.payment.id === payment.id);
  if (!isAccepted) return null;
  const presentation = paymentPresentation(payment, selfId, id => participantName(group.participants, selfId, id));
  const status = payment.reversed ? `${presentation.status} · No bank refund` : presentation.status;
  return <Pressable accessibilityRole="button" accessibilityLabel={`Payment, ${presentation.title}, ${formatMoney(payment.amount)}${status ? `, ${status}` : ''}, ${displayDate(payment.date)}`}
    disabled={busy} style={({ pressed }) => [ui.row, s.paymentRow, pressed && s.pressed]} onPress={() => onPayment(payment)}>
    <Icon name={payment.reversed ? 'refresh' : 'payment'} size={18} color={colors.muted} />
    <Text style={[ui.rowSub, s.paymentSentence, { color: colors.text }]}>{presentation.title} {formatMoney(payment.amount)}<Text style={ui.rowSub}>{!!status && ` · ${status}`} · {displayDate(payment.date)}</Text></Text>
  </Pressable>;
}

function BillTimelineRow({ expense, group, selfId, busy, onExpense, noticeVisibility }: Pick<Props, 'group' | 'selfId' | 'busy' | 'onExpense' | 'noticeVisibility'> & { expense: BillRow }) {
  const { palette: colors, ui } = useUI();
  const change = expenseBalanceChange(expense, selfId);
  const ownShare = formatMoney(expense.shares[selfId] ?? '0');
  const payers = Object.entries(expense.paid).filter(([, amount]) => BigInt(amount) > 0n).map(([id, amount]) => `${participantName(group.participants, selfId, id)} paid ${formatMoney(amount)}`).join(', ');
  return <VisibleExpense groupId={group.id} expense={expense} visibility={noticeVisibility}>
    <TransactionRow icon="bill" title={`${expense.description}${expense.deleted ? ' · Reversed' : ''}`} amount={expense.total} busy={busy} onPress={() => onExpense(expense)}
      label={`Bill, ${expense.description}, total ${formatMoney(expense.total)}, ${billImpact(change)}, ${payers}, Your share ${ownShare}, ${displayDate(expense.date)}${expense.deleted ? ', reversed' : ''}`}>
      <Text style={ui.rowSub}>Bill · {payers}</Text>
      <Text style={ui.rowSub}>Your share {ownShare} · {displayDate(expense.date)}</Text>
      <Text style={[ui.rowSub, { color: balanceColor(change, colors) }]}>{billImpact(change)}</Text>
    </TransactionRow>
  </VisibleExpense>;
}

function RecordSummary({ title, amount, amountColor, children }: { title: string; amount: string; amountColor?: string; children: React.ReactNode }) {
  const { ui } = useUI();
  return <View style={s.summary}>
    <SectionHeading>{title}</SectionHeading>
    <Text style={[ui.numeric, amountColor && { color: amountColor }]}>{formatMoney(amount)}</Text>
    {children}
  </View>;
}

function ParticipantAmountRow({ name, amount }: { name: string; amount: string }) {
  const { ui } = useUI();
  return <View style={[ui.row, { flexWrap: 'wrap' }]}>
    <Avatar name={name} /><Text accessibilityLabel={name} style={[ui.rowTitle, s.flex, { minWidth: 120 }]}>{name}</Text><AmountText amount={amount} style={{ marginLeft: 'auto' }} />
  </View>;
}

function BillSearch({ value, onChange, onSearch, showSubmit, busy }: { value: string; onChange: (value: string) => void; onSearch: () => void; showSubmit: boolean; busy: boolean }) {
  const { palette: colors, ui, inputColors } = useUI();
  return <View style={s.search}>
    <TextInput {...inputColors} accessibilityLabel="Search bills" placeholder="Find a bill by name or note" placeholderTextColor={colors.muted} value={value} onChangeText={onChange} onSubmitEditing={onSearch} returnKeyType="search" style={[ui.input, s.flex]} />
    {showSubmit && <Button title="Search" disabled={busy} onPress={onSearch} />}
  </View>;
}

export default function GroupScreen({ noticeVisibility, group, accepted, pending, durable = true, busy, selfId, onHistoryPage, onExpense, onPayment, onSettle, onSync, onDiscard, onReview, onConfirmReceipt }: Props) {
  const { ui } = useUI();
  const historyResource = group.transactions ? 'transactions' : 'bills';
  const [search, setSearch] = useState(group.history?.[historyResource]?.query ?? '');
  const expenses = group.read_mode === 'summary' ? group.expenses : group.expenses.filter(expense => group.expenses.length < 5 || `${expense.description} ${expense.notes}`.toLowerCase().includes(search.trim().toLowerCase()));
  const needsAttention = pending.some(command => command.state !== 'pending' || !!command.error);
  const receipts = (group.payment_attempts ?? []).filter(attempt =>
    attempt.recipient === selfId && ['reported', 'recorded', 'cancelled'].includes(attempt.state)
    && [attempt.sender, attempt.recipient].every(id => group.participants.some(person => person.id === id && !person.removed))
    && !group.settlements.some(settlement => settlement.reversed && (settlement.id === attempt.settlement_id || settlement.attempt_id === attempt.id)));
  const transfers = personalTransfers(group, selfId);
  const celebrateSettled = pending.length === 0 && accepted.balances?.[selfId] === '0';
  const rows: GroupTransaction[] = group.transactions ?? (group.read_mode === 'summary' ? expenses : [...expenses].reverse()).map(bill => ({ kind: 'bill', date: bill.date, bill }));
  const payments = personalSettlements(group, selfId);
  return <View role="region" accessibilityLabel={group.name} style={s.content}>
    {group.archived && <Text style={ui.notice}>Archived. Reopen in settings to make changes.{receipts.length > 0 ? ' You can still confirm money received.' : ''}</Text>}
    {pending.length > 0 && <View style={s.section}>
      <Text style={[ui.notice, ui.warning]}>{needsAttention ? 'Some changes need your attention.' : durable ? 'Waiting to sync.' : 'Not confirmed. Keep this tab open and reconnect.'}</Text>
      <Disclosure title={`${pending.length} ${durable ? 'saved' : 'temporary'} ${pending.length === 1 ? 'change' : 'changes'}`} initialOpen={needsAttention}>
        <Button title="Retry sync" disabled={busy} onPress={onSync} />
        {pending.map(command => <PendingChangeRow key={command.command_id} command={command} busy={busy} onReview={onReview} onDiscard={onDiscard} />)}
      </Disclosure>
    </View>}
    {receipts.map(attempt => <ReceiptRequest key={attempt.id} attempt={attempt} groupName={group.name} senderName={participantName(group.participants, selfId, attempt.sender)} disabled={busy || pending.length > 0} onConfirm={onConfirmReceipt} />)}
    <HistoryPages history={group.history?.attempts} resource="attempts" busy={busy} onPage={onHistoryPage} />
    {!transfers.length && <Text style={celebrateSettled ? ui.numeric : ui.caption}>{celebrateSettled ? '🎉 All settled' : 'All settled'}</Text>}
    {transfers.map(transfer => <PersonalTransferRow key={`${transfer.sender}:${transfer.recipient}`} transfer={transfer} group={group} selfId={selfId} disabled={busy || !!group.archived || pending.length > 0} onSettle={onSettle} />)}
    <SectionHeading style={ui.caption}>Bills and payments</SectionHeading>
      {(rows.length >= 5 || !!(group.history?.[historyResource]?.next_cursor || group.history?.[historyResource]?.previous?.length || group.history?.[historyResource]?.query)) && <BillSearch value={search} onChange={setSearch} onSearch={() => onHistoryPage?.(historyResource, 'search', search.trim())} showSubmit={group.read_mode === 'summary'} busy={busy} />}
      {!rows.length && <View style={s.empty}>
        <Icon name="bill" size={32} />
        <Text style={ui.section}>{group.history?.[historyResource]?.query || (group.read_mode !== 'summary' && search.trim()) ? 'No matching bills' : 'No bills or payments yet'}</Text>
      </View>}
      {rows.length > 0 && <View role="list" accessibilityLabel="Bills and payments">{rows.map(row => <View role="listitem" key={row.kind === 'payment' ? `payment:${row.payment.id}` : `bill:${row.bill.id}`}>{row.kind === 'payment'
        ? <PaymentRow key={`payment:${row.payment.id}`} payment={row.payment} accepted={accepted} group={group} selfId={selfId} busy={busy} onPayment={onPayment} />
        : <BillTimelineRow key={`bill:${row.bill.id}`} expense={row.bill} group={group} selfId={selfId} busy={busy} onExpense={onExpense} noticeVisibility={group === accepted ? noticeVisibility : undefined} />}</View>)}</View>}
      {group.transactions === undefined && (!!payments.length || !!group.history?.settlements?.next_cursor || !!group.history?.settlements?.previous?.length) && <Disclosure title="Payment records">
        {payments.length > 0 && <View>{payments.map(payment => <PaymentRow key={`payment:${payment.id}`} payment={payment} accepted={accepted} group={group} selfId={selfId} busy={busy} onPayment={onPayment} />)}</View>}
        <HistoryPages history={group.history?.settlements} resource="settlements" busy={busy} onPage={onHistoryPage} />
      </Disclosure>}
      <HistoryPages history={group.history?.[historyResource]} resource={historyResource} busy={busy} onPage={onHistoryPage} />
  </View>;
}

function RecordAttribution({ action, name }: { action: string; name?: string | null }) {
  const { ui } = useUI();
  return <Text style={ui.caption}>{action} by {name || 'unknown'}</Text>;
}

export function PaymentDetail({ payment, group, selfId, busy, canReverse, onReverse }: { payment: Settlement; group: Group; selfId: string; busy: boolean; canReverse: boolean; onReverse: () => void }) {
  const { palette: colors, ui } = useUI();
  const name = (id: string) => participantName(group.participants, selfId, id);
  const row = paymentPresentation(payment, selfId, name);
  const involved = payment.sender === selfId || payment.recipient === selfId;
  return <View role="region" accessibilityLabel={group.name} style={s.content}>
    <RecordSummary title={row.title} amount={payment.amount} amountColor={row.cashflow === '0' ? colors.text : balanceColor(row.cashflow, colors)}>
      <Text style={ui.caption}>{group.name} · {displayDate(payment.date)}{row.status ? ` · ${row.status}` : ''}</Text>
      <RecordAttribution action="Marked paid" name={payment.recorded_by_name} />
      {payment.reversed && <RecordAttribution action="Reversed" name={payment.reversal?.actor_name} />}
    </RecordSummary>
    {payment.reversed ? <Text style={ui.notice}>This payment record was reversed. No bank transfer was reversed.</Text>
      : <>{involved && <View style={s.section}><Button title="Reverse record" kind="danger" disabled={busy || !canReverse || group.archived || [payment.sender, payment.recipient].some(id => group.participants.find(person => person.id === id)?.removed)} onPress={onReverse} /><Text style={ui.caption}>Reverses this record, not a bank transfer.</Text></View>}</>}
  </View>;
}

export function ExpenseDetail({ noticeVisibility, expense, group, selfId, busy, canEdit, onEdit, onReverse, attachments, chat }: { noticeVisibility?: NoticeVisibility; expense: Expense; group: Group; selfId: string; busy: boolean; canEdit: boolean; onEdit: () => void; onReverse: () => void; attachments?: React.ReactNode; chat?: React.ReactNode }) {
  const { palette: colors, ui } = useUI();
  const hasCategory = !!expense.category && !['general', 'other'].includes(expense.category);
  const change = expenseBalanceChange(expense, selfId);
  const payers = group.participants.filter(person => BigInt(expense.paid[person.id] ?? '0') > 0n);
  const sharing = group.participants.filter(person => Object.hasOwn(expense.split.values, person.id));
  return <View role="region" accessibilityLabel={group.name} style={s.content}>
    <VisibleExpense groupId={group.id} expense={expense} visibility={(group.expenses.find(value => value.id === expense.id) ?? group.focused_expense) === expense ? noticeVisibility : undefined}><RecordSummary title={expense.description} amount={expense.total}>
      <Text style={[ui.body, { color: balanceColor(change, colors) }]}>{billImpact(change)}</Text>
      <Text style={ui.caption}>{group.name} · {displayDate(expense.date)}</Text>
      <RecordAttribution action="Added" name={expense.added_by} />
      {expense.deleted && <RecordAttribution action="Reversed" name={expense.reversal?.actor_name} />}
    </RecordSummary></VisibleExpense>
    {expense.deleted ? <Text style={ui.notice}>Bill record reversed. The original and its reversal are kept in history.</Text>
      : <Button title="Edit bill" icon="bill" kind="primary" disabled={busy || !canEdit} onPress={onEdit} />}
    {chat}
    {attachments}
    <BillPeople icon="pay" title="Who paid?" summary={`${payers.length} people`} inline={payers.length <= 1} disabled={busy}>
      {payers.map(person => <ParticipantAmountRow key={person.id} name={person.name} amount={expense.paid[person.id] ?? '0'} />)}
    </BillPeople>
    <BillPeople icon="people" title="Split between" summary={`${sharing.length} people`} inline={sharing.length <= 1} disabled={busy}>
      <Text style={ui.caption}>{expense.split.mode === 'equal' ? 'Shared equally' : expense.split.mode === 'exact' ? 'Exact amounts' : expense.split.mode === 'percent' ? 'By percentage' : 'By shares'}</Text>
      {sharing.map(person => <ParticipantAmountRow key={person.id} name={person.name} amount={expense.shares[person.id] ?? '0'} />)}
    </BillPeople>
    {(!!expense.notes || hasCategory) && <View style={s.section}>
      {!!expense.notes && <Text style={ui.body}>{expense.notes}</Text>}
      {hasCategory && <Text style={ui.caption}>Category: {expense.category}</Text>}
    </View>}
    {!expense.deleted && <Button title="Reverse record" kind="danger" disabled={busy || !canEdit} onPress={onReverse} />}
    {!canEdit && <Text style={ui.caption}>{group.archived ? 'Reopen this group in settings before changing a bill.' : 'Send or discard saved changes before changing this bill.'}</Text>}
  </View>;
}
const historyPageStyle = { flexDirection: 'row', flexWrap: 'wrap', gap: 8 } as const;
const s = StyleSheet.create({
  content: { gap: 10 },
  summary: { gap: 4, paddingVertical: 8 },
  section: { gap: 10, paddingVertical: 4 },
  receipt: { gap: 12, padding: 12, borderRadius: radii.surface },
  trailing: { flexShrink: 0, gap: 4, alignItems: 'flex-end' },
  paymentRow: { minHeight: 44, paddingVertical: 8 },
  paymentSentence: { flex: 1, minWidth: 0, fontWeight: '400' },
  empty: { gap: 10, alignItems: 'center', paddingVertical: 20 },
  pressed: { opacity: 0.65 },
  search: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  flex: { flex: 1, minWidth: 0 },
});
