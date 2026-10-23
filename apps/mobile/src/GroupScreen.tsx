import React, { useMemo, useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';
import { formatMoney } from './accounting';
import { Text } from 'react-native-paper';
import type { Command, Expense, Group, Settlement } from './types';
import { Avatar, Button, Disclosure, Icon, radii, useUI } from './ui';
import type { Palette } from './ui';

type Transfer = { sender: string; recipient: string; amount: string };
type Props = {
  group: Group; accepted: Group; pending: Command[]; busy: boolean; local: boolean; selfId: string;
  onAdd: () => void; onExpense: (expense: Expense) => void; onSettle: (transfer?: Transfer) => void;
  onReverse: (settlement: Settlement) => void; onSettings: () => void;
  onSync: () => void; onDiscard: (command: Command) => void;
  onReview: (command: Command) => void;
  onConfirmReceipt: (attempt: NonNullable<Group['payment_attempts']>[number]) => void;
};
export const position = (name: string, value: string) => BigInt(value) > 0n ? `${name} ${name === 'You' ? 'are' : 'is'} owed ${formatMoney(value)}` : BigInt(value) < 0n ? `${name} ${name === 'You' ? 'owe' : 'owes'} ${formatMoney((-BigInt(value)).toString())}` : `${name} ${name === 'You' ? 'are' : 'is'} settled up`;
const displayDate = (value: string) => {
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
};

export default function GroupScreen({ group, accepted, pending, busy, local, selfId, onAdd, onExpense, onSettle, onReverse, onSettings, onSync, onDiscard, onReview, onConfirmReceipt }: Props) {
  const { palette: colors, ui, inputColors } = useUI();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const [section, setSection] = useState('Bills');
  const [search, setSearch] = useState('');
  const expenses = group.expenses.filter(expense => group.expenses.length < 5 || `${expense.description} ${expense.notes}`.toLowerCase().includes(search.trim().toLowerCase()));
  const name = (id: string) => id === selfId ? 'You' : group.participants.find(person => person.id === id)?.name ?? 'Former member';
  const balance = BigInt(group.balances[selfId] ?? '0');
  const needsAttention = pending.some(command => command.state !== 'pending' || !!command.error);
  const receipts = (group.payment_attempts ?? []).filter(attempt => attempt.recipient === selfId && ['reported', 'recorded', 'cancelled'].includes(attempt.state));
  const purchases = group.expenses.filter(expense => !expense.deleted);
  const spending = purchases.reduce((total, expense) => total + BigInt(expense.total), 0n).toString();
  const searchField = <TextInput {...inputColors} accessibilityLabel="Search bills" placeholder="Find a bill by name or note" placeholderTextColor={colors.muted} value={search} onChangeText={setSearch} style={ui.input} />;
  return <View style={s.content}>
    <View style={s.summary}>
      <Text style={ui.caption}>{balance > 0n ? 'You are owed' : balance < 0n ? 'You owe' : 'Your balance'}</Text>
      <Text style={ui.numeric}>{balance === 0n ? 'All settled' : formatMoney((balance < 0n ? -balance : balance).toString())}</Text>
      <Text style={ui.caption}>{pending.length ? 'Includes your changes saved on this phone' : local ? 'Saved on this phone' : 'In this group'}</Text>
    </View>
    {group.archived && <Text style={ui.notice}>This group is archived. Reopen it in settings to add bills or record payments.{receipts.length > 0 ? ' You can still confirm money received.' : ''}</Text>}
    <Button title="Add a bill" icon="add" kind="primary" disabled={busy || group.archived} onPress={onAdd} />
    {pending.length > 0 && <View style={s.section}>
      <Text style={ui.notice}>{needsAttention ? 'Some saved changes need your attention.' : 'Saved on this phone. Waiting to sync.'} Other people see the shared records until these changes are sent.</Text>
      <Disclosure title={`${pending.length} saved ${pending.length === 1 ? 'change' : 'changes'}`} initialOpen={needsAttention}>
        {needsAttention && <Button title="Retry sync" disabled={busy} onPress={onSync} />}
        {pending.map(command => <View key={command.command_id} style={s.section}>
          <Text style={ui.rowTitle}>{String(command.body.description ?? 'Group change')}</Text>
          <Text style={ui.caption}>{command.state === 'pending' ? 'Waiting to sync' : command.error ?? 'Needs review'}</Text>
          {command.state !== 'pending' && ['POST', 'PUT'].includes(command.method) && command.path.includes('/expenses') && <Button title="Review my saved change" disabled={busy} onPress={() => onReview(command)} />}
          <Button kind="text" title={command.path === '/groups' ? 'Discard unsent group' : 'Discard this saved change'} disabled={busy} onPress={() => onDiscard(command)} />
        </View>)}
      </Disclosure>
    </View>}
    {receipts.map(attempt => <View key={attempt.id} style={s.receipt}>
      <Text style={ui.section}>Did you get {formatMoney(attempt.recorded_amount ?? attempt.amount)} from {name(attempt.sender)}?</Text>
      <Text style={ui.caption}>{group.name}. {attempt.state === 'cancelled' ? 'The earlier report was cancelled. ' : ''}Check your bank or UPI app before confirming.</Text>
      <Button title={`Yes, I got ${formatMoney(attempt.recorded_amount ?? attempt.amount)}`} icon="check" disabled={busy || pending.length > 0} onPress={() => onConfirmReceipt(attempt)} />
    </View>)}
    <View style={s.tabs} accessibilityRole="tablist">
      {['Bills', 'Who owes?', 'Totals'].map(value => <Pressable key={value} accessibilityRole="tab" accessibilityState={{ selected: section === value }} onPress={() => setSection(value)} style={[s.tab, section === value && s.selectedTab]}>
        <Text style={[s.tabText, section === value && s.selectedTabText]}>{value}</Text>
      </Pressable>)}
    </View>
    {section === 'Bills' && <>
      {group.expenses.length >= 5 && searchField}
      {!expenses.length && <View style={s.empty}>
        <Icon name="bill" size={32} />
        <Text style={ui.section}>{search.trim() ? 'No matching bills' : 'Your first bill goes here'}</Text>
        <Text style={ui.caption}>{search.trim() ? 'Try another name or a word from the notes.' : 'Add what was paid and who shared it.'}</Text>
      </View>}
      {[...expenses].reverse().map(expense => <Pressable accessibilityRole="button" accessibilityLabel={`${expense.description}, ${formatMoney(expense.total)}${expense.deleted ? ', deleted' : ''}`} key={expense.id} style={({ pressed }) => [ui.row, pressed && s.pressed]} onPress={() => onExpense(expense)}>
        <View style={s.billMark}><Icon name="bill" /></View>
        <View style={ui.rowBody}>
          <Text style={ui.rowTitle}>{expense.description}{expense.deleted ? ' · Deleted' : ''}</Text>
          <Text style={ui.rowSub}>{Object.entries(expense.paid).filter(([, amount]) => BigInt(amount) > 0n).map(([id, amount]) => `${name(id)} paid ${formatMoney(amount)}`).join(', ')}</Text>
          <Text style={ui.rowSub}>{displayDate(expense.date)}</Text>
        </View>
        <View style={s.trailing}><Text style={s.amount}>{formatMoney(expense.total)}</Text><Icon name="next" size={18} color={colors.muted} /></View>
      </Pressable>)}
      {group.settlements.length > 0 && <Disclosure title="Payment records">
        <Text style={ui.caption}>These record money paid outside the app. A record does not verify a bank transfer.</Text>
        {group.settlements.map(payment => <View key={payment.id} style={s.payment}>
          <Text style={ui.rowTitle}>{name(payment.sender)} paid {name(payment.recipient)}</Text>
          <Text style={s.amount}>{formatMoney(payment.amount)}</Text>
          <Text style={ui.caption}>{payment.reversed ? 'Record reversed' : payment.method === 'recipient_confirmed' || payment.method === 'manual_then_confirmed' ? 'Receipt confirmed by the recipient' : 'Recorded outside the app. Receipt not confirmed.'}</Text>
          {!payment.reversed && <Button title="Reverse record" accessibilityLabel={`Reverse ${formatMoney(payment.amount)} payment from ${name(payment.sender)} to ${name(payment.recipient)}`} kind="text" disabled={busy || group.archived || pending.length > 0} onPress={() => onReverse(payment)} />}
        </View>)}
      </Disclosure>}
    </>}
    {section === 'Who owes?' && <>
      <Text style={ui.section}>In this group</Text>
      {group.participants.map(person => <View key={person.id} style={ui.row}>
        <Avatar name={name(person.id)} />
        <View style={ui.rowBody}>
          <Text style={ui.rowTitle}>{name(person.id)}</Text>
          <Text style={ui.rowSub}>{position(name(person.id), group.balances[person.id] ?? '0')}</Text>
          {pending.length > 0 && <Text style={ui.rowSub}>Shared record: {position(name(person.id), accepted.balances[person.id] ?? '0')}</Text>}
        </View>
      </View>)}
      <View style={s.section}>
        <Text style={ui.section}>Pay back</Text>
        <Text style={ui.caption}>A simpler plan for this group. Your bills stay the same.</Text>
        {group.transfers.map((transfer, index) => <View key={index} style={s.transfer}>
          <Text style={ui.rowTitle}>{name(transfer.sender)} {transfer.sender === selfId ? 'owe' : 'owes'} {name(transfer.recipient)} {formatMoney(transfer.amount)}</Text>
          <Button title={`Record ${formatMoney(transfer.amount)}`} accessibilityLabel={`Record ${formatMoney(transfer.amount)} from ${name(transfer.sender)} to ${name(transfer.recipient)}`} icon="pay" disabled={busy || group.archived} onPress={() => onSettle(transfer)} />
        </View>)}
        {!group.transfers.length && <Text style={ui.body}>Everyone is settled up.</Text>}
        <Text style={ui.caption}>Already paid outside the app? Record it here. No money is sent by this app.</Text>
        <Disclosure title="How fewer payments work">
          <Text style={ui.body}>Each person keeps the same total to pay or receive. The plan combines repayments within {group.name}, so you may pay someone other than the person who paid a bill.</Text>
          <Text style={ui.caption}>Other groups are separate. Recording a payment updates this group's balances.</Text>
        </Disclosure>
        <Disclosure title="A different payment was already made">
          <Button title="Record a payment" disabled={busy || group.archived} onPress={() => onSettle()} />
        </Disclosure>
      </View>
    </>}
    {section === 'Totals' && <>
      <View style={s.summary}><Text style={ui.caption}>Spent together</Text><Text style={ui.numeric}>{formatMoney(spending)}</Text><Text style={ui.caption}>Repayments are not spending.</Text></View>
      {group.participants.map(person => <View key={person.id} style={ui.row}>
        <Avatar name={name(person.id)} />
        <View style={ui.rowBody}>
          <Text style={ui.rowTitle}>{name(person.id)}</Text>
          <Text style={ui.rowSub}>Paid {formatMoney(purchases.reduce((total, expense) => total + BigInt(expense.paid[person.id] ?? '0'), 0n).toString())}</Text>
          <Text style={ui.rowSub}>Share {formatMoney(purchases.reduce((total, expense) => total + BigInt(expense.shares[person.id] ?? '0'), 0n).toString())}</Text>
        </View>
      </View>)}
    </>}
    <Button title="Group settings and people" icon="settings" kind="text" disabled={busy} onPress={onSettings} />
  </View>;
}

export function ExpenseDetail({ expense, group, busy, canEdit, onEdit, onDelete, onRestore }: { expense: Expense; group: Group; busy: boolean; canEdit: boolean; onEdit: () => void; onDelete: () => void; onRestore: () => void }) {
  const { palette: colors, ui } = useUI();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const hasCategory = !!expense.category && !['general', 'other'].includes(expense.category);
  return <View style={s.content}>
    <View style={s.summary}>
      
      <Text style={ui.numeric}>{formatMoney(expense.total)}</Text>
      <Text style={ui.caption}>{group.name} · {displayDate(expense.date)}</Text>
    </View>
    {expense.deleted ? <>
      <Text style={ui.notice}>This bill was deleted. Its original split is kept so you can restore it.</Text>
      <Button title="Restore bill" icon="history" kind="primary" disabled={busy || !canEdit} onPress={onRestore} />
    </> : <Button title="Edit bill" icon="bill" kind="primary" disabled={busy || !canEdit} onPress={onEdit} />}
    <View style={s.section}>
      <Text style={ui.section}>Who paid?</Text>
      {group.participants.filter(person => BigInt(expense.paid[person.id] ?? '0') > 0n).map(person => <View key={person.id} style={ui.row}>
        <Avatar name={person.name} /><Text style={[ui.rowTitle, s.flex]}>{person.name}</Text><Text style={s.amount}>{formatMoney(expense.paid[person.id] ?? '0')}</Text>
      </View>)}
    </View>
    <View style={s.section}>
      <Text style={ui.section}>Split between</Text>
      <Text style={ui.caption}>{expense.split.mode === 'equal' ? 'Shared equally' : expense.split.mode === 'exact' ? 'Exact amounts' : expense.split.mode === 'percent' ? 'By percentage' : 'By shares'}</Text>
      {group.participants.filter(person => Object.hasOwn(expense.split.values, person.id)).map(person => <View key={person.id} style={ui.row}>
        <Avatar name={person.name} /><Text style={[ui.rowTitle, s.flex]}>{person.name}</Text><Text style={s.amount}>{formatMoney(expense.shares[person.id] ?? '0')}</Text>
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
  trailing: { maxWidth: '42%', gap: 4, alignItems: 'flex-end' },
  amount: { color: colors.text, fontSize: 17, lineHeight: 24, fontWeight: '600', fontVariant: ['tabular-nums'], flexShrink: 1, textAlign: 'right' },
  payment: { gap: 6, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  transfer: { gap: 8, paddingVertical: 10 },
  empty: { gap: 10, alignItems: 'center', paddingVertical: 20 },
  pressed: { opacity: 0.65 },
  flex: { flex: 1 },
});
