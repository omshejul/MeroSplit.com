import React, { useRef, useState } from 'react';
import BillPeople from './BillPeople';
import BalanceExplanation, { type BalanceSelection } from './BalanceExplanationDialog';
import { balanceKey } from './balanceExplanation';
import type { BalanceSource } from './balanceExplanationStorage';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';
import { expenseBalanceChange, formatMoney } from './accounting';
import { Text } from 'react-native-paper';
import { personalSettlements, personalTransfers } from './personalBalances';
import { paymentPresentation } from './activityPresentation';
import { VisibleExpense } from './useExpenseNotices';
import type { NoticeVisibility } from './useExpenseNotices';
import type { BillRow, Command, Expense, Group, GroupTransaction, Participant, Settlement, HistoryResource, HistoryWindow } from './types';
import { SectionHeading, AmountText, Avatar, balanceColor, Button, Disclosure, Icon, radii, useUI } from './ui';

type Transfer = { sender: string; recipient: string; amount: string };
type Props = {
  noticeVisibility?: NoticeVisibility;
  group: Group; accepted: Group; durable?: boolean; pending: Command[]; busy: boolean; selfId: string;
  onLoadBalanceGroup?: (expected: Group) => Promise<BalanceSource>;
  onHistoryPage?: (resource: HistoryResource, direction: 'next' | 'previous' | 'search', query?: string) => void;
  onExpense: (expense: BillRow) => void; onPayment: (payment: Settlement) => void; onSettle: (transfer?: Transfer) => void;
  onReverse: (settlement: Settlement) => void;
  onSync: () => void; onDiscard: (command: Command) => void;
  onReview: (command: Command) => void;
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

function PersonalTransferRow({ transfer, group, selfId, disabled, onSettle, onExplain }: { transfer: Transfer; group: Group; selfId: string; disabled: boolean; onSettle: Props['onSettle']; onExplain: (transfer: Transfer, restoreFocus: () => void) => void }) {
  const { palette: colors, ui } = useUI();
  const row = useRef<React.ComponentRef<typeof View>>(null);
  const outgoing = transfer.sender === selfId, counterpart = outgoing ? transfer.recipient : transfer.sender;
  const person = group.participants.find(person => person.id === counterpart), removed = person?.removed;
  const name = participantName(group.participants, selfId, counterpart);
  const action = outgoing && person?.user_id != null && !!person.payment_profile?.vpa ? 'Pay' : 'Record';
  return <View style={ui.row}>
    <Pressable ref={row} accessibilityRole="button" accessibilityLabel={`Why ${outgoing ? 'you owe' : 'you are owed'} ${formatMoney(transfer.amount)} ${outgoing ? 'to' : 'by'} ${name}`} onPress={() => onExplain(transfer, () => row.current?.focus())} style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44 }}>
      <Avatar name={name} />
      <View style={ui.rowBody}><Text numberOfLines={1} ellipsizeMode="tail" style={[ui.rowTitle, s.logTitle]}>{name}</Text><Text style={[ui.rowSub, s.logCaption]}>{outgoing ? 'You owe' : 'Owes you'}{removed ? ' · Removed' : ''}</Text></View>
      <AmountText amount={transfer.amount} style={[s.balanceAmount, { color: outgoing ? colors.negative : colors.positive }]} />
    </Pressable>
    <Button title={action} kind={action === 'Pay' ? 'outlined' : 'text'} icon={action === 'Pay' ? 'pay' : undefined} compact accessibilityLabel={`${action} payment ${outgoing ? 'to' : 'from'} ${name}, ${formatMoney(transfer.amount)}`} disabled={disabled || !!removed} onPress={() => onSettle(transfer)} />
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
function LogRow({ date, label, busy, onPress, trailing, children, payment = false }: { date?: string | null; label: string; busy: boolean; onPress: () => void; trailing?: React.ReactNode; children: React.ReactNode; payment?: boolean }) {
  const { ui, palette } = useUI();
  return <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={busy} style={({ pressed }) => [ui.row, s.edgeRow, { borderBottomColor: `${palette.line}80` }, payment && { backgroundColor: palette.soft }, pressed && s.pressed]} onPress={onPress}>
    <LogDate date={date} />
    <View style={ui.rowBody}>{children}</View>
    {trailing}
  </Pressable>;
}

function PaymentRow({ payment, accepted, group, selfId, busy, onPayment }: Pick<Props, 'accepted' | 'group' | 'selfId' | 'busy' | 'onPayment'> & { payment: Settlement }) {
  const { palette: colors, ui } = useUI();
  const isAccepted = accepted.settlements.some(record => record.id === payment.id) || accepted.transactions?.some(record => record.kind === 'payment' && record.payment.id === payment.id);
  if (!isAccepted) return null;
  const presentation = paymentPresentation(payment, selfId, id => participantName(group.participants, selfId, id));
  const status = presentation.status;
  return <LogRow payment date={payment.date} busy={busy} onPress={() => onPayment(payment)} label={`Payment, ${presentation.title}, ${formatMoney(payment.amount)}${status ? `, ${status}` : ''}, ${displayDate(payment.date)}`}>
    <View style={s.paymentLine}>
      <Icon name={payment.reversed ? 'refresh' : 'payment'} size={18} color={colors.muted} />
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

function BillTimelineRow({ expense, group, selfId, busy, onExpense, noticeVisibility }: Pick<Props, 'group' | 'selfId' | 'busy' | 'onExpense' | 'noticeVisibility'> & { expense: BillRow }) {
  const { ui } = useUI();
  const change = expenseBalanceChange(expense, selfId), name = (id: string) => participantName(group.participants, selfId, id);
  const paidBy = Object.entries(expense.paid).filter(([, amount]) => BigInt(amount) > 0n);
  const involved = BigInt(expense.shares[selfId] ?? '0') > 0n || BigInt(expense.paid[selfId] ?? '0') > 0n;
  const who = paidBy.length === 1 ? name(paidBy[0][0]) : paidBy.length === 2 ? `${name(paidBy[0][0])} and ${name(paidBy[1][0])}` : `${paidBy.length} people`;
  const payers = paidBy.map(([id, amount]) => `${name(id)} paid ${formatMoney(amount)}`).join(', ');
  return <VisibleExpense groupId={group.id} expense={expense} visibility={noticeVisibility}>
    <LogRow date={expense.date} busy={busy} onPress={() => onExpense(expense)} trailing={<BillEffect change={change} involved={involved} reversed={!!expense.deleted} />}
      label={`Bill, ${expense.description}, total ${formatMoney(expense.total)}, ${expense.deleted ? 'reversed, no balance impact' : billImpact(change)}, ${payers || 'no payer recorded'}, Your share ${formatMoney(expense.shares[selfId] ?? '0')}, ${displayDate(expense.date)}`}>
      <Text numberOfLines={2} ellipsizeMode="tail" style={[ui.rowTitle, s.logTitle]}>{expense.description}</Text>
      <Text style={[ui.rowSub, s.logCaption]}>{paidBy.length ? `${who} paid ${formatMoney(expense.total)}` : `Total ${formatMoney(expense.total)}`}</Text>
    </LogRow>
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

function BillSearch({ value, onChange, onSearch, showSubmit, busy, autoFocus }: { value: string; onChange: (value: string) => void; onSearch: () => void; showSubmit: boolean; busy: boolean; autoFocus: boolean }) {
  const { palette: colors, ui, inputColors } = useUI();
  return <View style={s.search}>
    <TextInput {...inputColors} autoFocus={autoFocus} accessibilityLabel="Search bills" placeholder="Find a bill by name or note" placeholderTextColor={colors.muted} value={value} onChangeText={onChange} onSubmitEditing={onSearch} returnKeyType="search" style={[ui.input, s.flex]} />
    {showSubmit && <Button title="Search" disabled={busy} onPress={onSearch} />}
  </View>;
}

export default function GroupScreen({ noticeVisibility, group, accepted, pending, durable = true, busy, selfId, onLoadBalanceGroup, onHistoryPage, onExpense, onPayment, onSettle, onSync, onDiscard, onReview }: Props) {
  const { ui } = useUI();
  const [explanation, setExplanation] = useState<BalanceSelection | null>(null);
  const historyResource = group.transactions ? 'transactions' : 'bills';
  const [search, setSearch] = useState(group.history?.[historyResource]?.query ?? ''), [searching, setSearching] = useState(false);
  const historyWindow = group.history?.[historyResource];
  const expenses = group.read_mode === 'summary' ? group.expenses : group.expenses.filter(expense => group.expenses.length < 5 || `${expense.description} ${expense.notes}`.toLowerCase().includes(search.trim().toLowerCase()));
  const needsAttention = pending.some(command => command.state !== 'pending' || !!command.error);
  const transfers = personalTransfers(group, selfId);
  const celebrateSettled = pending.length === 0 && accepted.balances?.[selfId] === '0';
  const rows: GroupTransaction[] = group.transactions ?? (group.read_mode === 'summary' ? expenses : [...expenses].reverse()).map(bill => ({ kind: 'bill', date: bill.date, bill }));
  const payments = personalSettlements(group, selfId);
  const searchable = rows.length >= 5 || !!(historyWindow?.next_cursor || historyWindow?.previous?.length || historyWindow?.query);
  const showSearch = searching || !!historyWindow?.query || !!search;
  return <View role="region" accessibilityLabel={group.name} style={s.content}>
    {group.archived && <Text style={ui.notice}>Archived. Reopen in settings to make changes.</Text>}
    {pending.length > 0 && <View style={s.section}>
      <Text style={[ui.notice, ui.warning]}>{needsAttention ? 'Some changes need your attention.' : durable ? 'Waiting to sync.' : 'Not confirmed. Keep this tab open and reconnect.'}</Text>
      <Disclosure title={`${pending.length} ${durable ? 'saved' : 'temporary'} ${pending.length === 1 ? 'change' : 'changes'}`} initialOpen={needsAttention}>
        <Button title="Retry sync" disabled={busy} onPress={onSync} />
        {pending.map(command => <PendingChangeRow key={command.command_id} command={command} busy={busy} onReview={onReview} onDiscard={onDiscard} />)}
      </Disclosure>
    </View>}
    {!transfers.length && <Text style={celebrateSettled ? ui.numeric : ui.caption}>{celebrateSettled ? '🎉 All settled' : 'All settled'}</Text>}
    {transfers.map(transfer => <PersonalTransferRow key={`${transfer.sender}:${transfer.recipient}`} transfer={transfer} group={group} selfId={selfId} disabled={busy || !!group.archived || pending.length > 0} onSettle={onSettle} onExplain={(transfer, restoreFocus) => setExplanation({ group, accepted, commands: pending, selfId, transfer, restoreFocus, load: onLoadBalanceGroup })} />)}
    {/* Search opens from the heading line; an active query or typed text keeps it open. */}
    <View style={s.logHeading}>
      <SectionHeading style={[ui.caption, s.logCaption, s.flex]}>Bills and payments</SectionHeading>
      {searchable && !showSearch && <Button title="Search" kind="text" accessibilityLabel="Search bills" onPress={() => setSearching(true)} />}
    </View>
      {showSearch && <BillSearch value={search} onChange={setSearch} onSearch={() => onHistoryPage?.(historyResource, 'search', search.trim())} showSubmit={group.read_mode === 'summary'} busy={busy} autoFocus={searching} />}
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
    <BalanceExplanation selection={explanation} currentKey={balanceKey(group, pending)} onClose={() => setExplanation(null)} />
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
    {payment.reversed ? <Text style={ui.notice}>This payment record was reversed.</Text>
      : <>{involved && <View style={s.section}><Button title="Reverse record" kind="danger" disabled={busy || !canReverse || group.archived || [payment.sender, payment.recipient].some(id => group.participants.find(person => person.id === id)?.removed)} onPress={onReverse} /></View>}</>}
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
  trailing: { flexShrink: 1, maxWidth: '45%', alignItems: 'flex-end' },
  effect: { flexShrink: 1, fontSize: 14, lineHeight: 20 },
  balanceAmount: { fontSize: 16, lineHeight: 22 },
  logTitle: { fontSize: 14, lineHeight: 20 },
  logCaption: { fontSize: 12, lineHeight: 17 },
  edgeRow: { minHeight: 44, marginHorizontal: -16, paddingHorizontal: 16 },
  date: { minWidth: 40, flexShrink: 0, alignItems: 'center' },
  dateMonth: { fontSize: 11, lineHeight: 14 },
  dateDay: { fontSize: 14, lineHeight: 18 },
  paymentLine: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  paymentSentence: { flex: 1, minWidth: 0, fontWeight: '400' },
  logHeading: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44 },
  empty: { gap: 10, alignItems: 'center', paddingVertical: 20 },
  pressed: { opacity: 0.65 },
  search: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  flex: { flex: 1, minWidth: 0 },
});
