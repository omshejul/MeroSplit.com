import React, { useState } from 'react';
import { Button, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { formatMoney } from './accounting';
import type { Command, Expense, Group, Settlement } from './types';

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

export default function GroupScreen({ group, accepted, pending, busy, local, selfId, onAdd, onExpense, onSettle, onReverse, onSettings, onSync, onDiscard, onReview, onConfirmReceipt }: Props) {
  const [section, setSection] = useState('Expenses');
  const [search, setSearch] = useState('');
  const expenses = group.expenses.filter(expense => `${expense.description} ${expense.notes}`.toLowerCase().includes(search.trim().toLowerCase()));
  const name = (id: string) => group.participants.find(person => person.id === id)?.name ?? 'Former member';
  return <View style={s.content}>
    {local && <Text>Saved on this device</Text>}
    {group.archived && <Text>This group is archived. Reopen it in group settings to add expenses.</Text>}
    <View style={s.actions}><Button title="Add expense" disabled={busy || group.archived} onPress={onAdd} /><Button title="Settle up" disabled={busy} onPress={() => onSettle()} /></View>
    {pending.length > 0 && <View style={s.section}><Text style={s.heading}>{pending.length} unsent {pending.length === 1 ? 'change' : 'changes'}</Text><Text>Balances below include your saved changes. Other people see accepted records until sync completes.</Text>
      <Button title="Sync now" disabled={busy} onPress={onSync} />
      {pending.map(command => <View key={command.command_id}><Text>{String(command.body.description ?? 'Group change')}: {command.state === 'pending' ? 'Waiting to sync' : command.error ?? 'Needs review'}</Text>{command.state !== 'pending' && ['POST', 'PUT'].includes(command.method) && command.path.includes('/expenses') && <Button title="Review saved change" disabled={busy} onPress={() => onReview(command)} />}<Button title={command.path === '/groups' ? 'Discard unsent group' : 'Discard this unsent change'} disabled={busy} onPress={() => onDiscard(command)} /></View>)}
    </View>}
    <View style={s.actions}>{['Expenses', 'Balances', 'Totals'].map(value => <Button key={value} title={section === value ? `${value} ✓` : value} onPress={() => setSection(value)} />)}</View>
    {section === 'Expenses' && <>
      <TextInput accessibilityLabel="Search expenses" placeholder="Search expenses" value={search} onChangeText={setSearch} style={{ minHeight: 44, borderWidth: 1, borderColor: '#888', padding: 8, color: '#111' }} />
      {!expenses.length && <Text>{search.trim() ? 'No matching expenses.' : 'No expenses yet. Add the first expense.'}</Text>}
      {[...expenses].reverse().map(expense => <Pressable accessibilityRole="button" accessibilityLabel={`${expense.description}, ${formatMoney(expense.total)}${expense.deleted ? ', deleted' : ''}`} key={expense.id} style={s.row} onPress={() => onExpense(expense)}>
        <Text style={s.heading}>{expense.description}{expense.deleted ? ' (deleted)' : ''}</Text><Text>{formatMoney(expense.total)} · {expense.date}</Text>
        <Text>{Object.entries(expense.paid).filter(([, amount]) => BigInt(amount) > 0n).map(([id, amount]) => `${name(id)} paid ${formatMoney(amount)}`).join(', ')}</Text>
      </Pressable>)}
      {group.settlements.map(payment => <View key={payment.id} style={s.row}><Text>{name(payment.sender)} paid {name(payment.recipient)} {formatMoney(payment.amount)}{payment.reversed ? ' (reversed)' : ''}</Text><Text>{payment.method === 'recipient_confirmed' || payment.method === 'manual_then_confirmed' ? 'Receipt acknowledged' : 'Recorded payment. Bank transfer not verified.'}</Text>
        <Button title="Reverse payment record" disabled={busy || !!payment.reversed || pending.length > 0} onPress={() => onReverse(payment)} />
      </View>)}
      {(group.payment_attempts ?? []).filter(attempt => attempt.recipient === selfId && ['reported', 'recorded', 'cancelled'].includes(attempt.state)).map(attempt => <View key={attempt.id} style={s.row}><Text>{name(attempt.sender)} to {name(attempt.recipient)}. Quoted {formatMoney(attempt.amount)}{attempt.recorded_amount ? `. Recorded ${formatMoney(attempt.recorded_amount)}` : ''}.</Text><Button title={`Confirm received ${formatMoney(attempt.recorded_amount ?? attempt.amount)}`} disabled={busy || pending.length > 0} onPress={() => onConfirmReceipt(attempt)} /></View>)}
    </>}
    {section === 'Balances' && <>
      {group.participants.map(person => <Text key={person.id} style={s.row}>{position(person.name, group.balances[person.id] ?? '0')}{pending.length ? `\nAccepted: ${formatMoney(accepted.balances[person.id] ?? '0')}` : ''}</Text>)}
      <Text style={s.heading}>Simplify debts</Text><Text>These repayments settle the group’s net balances.</Text>
      {group.transfers.map((transfer, index) => <Button key={index} title={`${name(transfer.sender)} pays ${name(transfer.recipient)} ${formatMoney(transfer.amount)}`} disabled={busy} onPress={() => onSettle(transfer)} />)}
      {!group.transfers.length && <Text>Everyone is settled up.</Text>}
    </>}
    {section === 'Totals' && <>
      <Text style={s.heading}>Purchase spending {formatMoney(group.expenses.filter(expense => !expense.deleted).reduce((total, expense) => total + BigInt(expense.total), 0n).toString())}</Text>
      <Text>Repayments are excluded from spending.</Text>
      {group.participants.map(person => <Text key={person.id} style={s.row}>{person.name} paid {formatMoney(group.expenses.filter(expense => !expense.deleted).reduce((total, expense) => total + BigInt(expense.paid[person.id] ?? '0'), 0n).toString())}; share {formatMoney(group.expenses.filter(expense => !expense.deleted).reduce((total, expense) => total + BigInt(expense.shares[person.id] ?? '0'), 0n).toString())}</Text>)}
    </>}
    <Button title="Group settings and members" disabled={busy} onPress={onSettings} />
  </View>;
}

export function ExpenseDetail({ expense, group, busy, canEdit, onEdit, onDelete, onRestore }: { expense: Expense; group: Group; busy: boolean; canEdit: boolean; onEdit: () => void; onDelete: () => void; onRestore: () => void }) {
  return <View style={s.content}><Text style={s.heading}>{formatMoney(expense.total)}</Text><Text>{expense.date}{expense.notes ? `\n${expense.notes}` : ''}</Text><Text>Split {expense.split.mode === 'equal' ? 'equally' : expense.split.mode === 'exact' ? 'by exact amounts' : expense.split.mode === 'percent' ? 'by percentages' : 'by shares'}</Text>
    {group.participants.filter(person => BigInt(expense.paid[person.id] ?? '0') > 0n || BigInt(expense.shares[person.id] ?? '0') > 0n).map(person => <View key={person.id} style={s.row}><Text>{person.name} paid {formatMoney(expense.paid[person.id] ?? '0')} and owes {formatMoney(expense.shares[person.id] ?? '0')}</Text></View>)}
    {expense.deleted ? <><Text>This expense was deleted. Its original split is preserved.</Text><Button title="Restore expense" disabled={busy || !canEdit} onPress={onRestore} /></> : <><Button title="Edit expense" disabled={busy || !canEdit} onPress={onEdit} /><Button title="Delete expense" disabled={busy || !canEdit} onPress={onDelete} /></>}
    {!canEdit && <Text>Sync or discard unsent changes before changing this expense.</Text>}
  </View>;
}
const s = StyleSheet.create({ content: { gap: 12 }, actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 }, section: { gap: 8, paddingVertical: 12 }, heading: { fontSize: 18, fontWeight: '600' }, row: { minHeight: 52, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: '#aaa', gap: 5 } });
