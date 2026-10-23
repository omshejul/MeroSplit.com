import React, { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { formatMoney, validateExpense } from './accounting';
import { Text } from 'react-native-paper';
import type { Amounts, Split } from './accounting';
import type { Command, Expense, Group } from './types';
import { Button, radii, useUI } from './ui';
import type { Palette } from './ui';

type Props = {
  command: Command; group: Group; busy: boolean;
  onDiscard: () => void; onEditSaved: (expense: Expense) => void;
};

function PersonAmount({ name, amount }: { name: string; amount: string }) {
  const { palette } = useUI();
  const s = useMemo(() => makeStyles(palette), [palette]);
  return <View style={s.person}><Text style={s.name}>{name}</Text><Text style={s.amount}>{formatMoney(amount)}</Text></View>;
}

function SavedBillSummary({ expense, participants }: { expense: Expense; participants: Group['participants'] }) {
  const { palette, ui } = useUI();
  const s = useMemo(() => makeStyles(palette), [palette]);
  return <View style={s.bill}>
    <Text style={ui.rowTitle}>{expense.description}</Text>
    <Text style={ui.numeric}>{formatMoney(expense.total)}</Text>
    <Text style={ui.caption}>{new Date(`${expense.date}T12:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}</Text>
    {expense.deleted && <Text style={[ui.notice, ui.warning]}>Deleted. This bill is not included in balances.</Text>}
    <Text style={ui.label}>Who paid?</Text>
    {participants.filter(person => (expense.paid[person.id] ?? '0') !== '0').map(person => <PersonAmount key={person.id} name={person.name} amount={expense.paid[person.id]} />)}
    <Text style={ui.label}>Split between</Text>
    {participants.filter(person => Object.hasOwn(expense.split.values, person.id)).map(person => <PersonAmount key={person.id} name={person.name} amount={expense.shares[person.id] ?? '0'} />)}
    {!!expense.notes && <Text style={ui.caption}>{expense.notes}</Text>}
  </View>;
}

export default function SavedChangeScreen({ command, group, busy, onDiscard, onEditSaved }: Props) {
  const { palette: colors, ui } = useUI();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const body = command.body;
  const current = group.expenses.find(expense => expense.id === body.id) ?? (group.focused_expense?.id === body.id ? group.focused_expense : undefined);
  const path = `/groups/${group.id}/expenses`;
  const creating = command.method === 'POST' && command.path === path;
  const updating = command.method === 'PUT' && command.path === `${path}/${body.id}`;
  const expenseCommand = command.group_id === group.id && (creating || updating);
  let saved: Expense | undefined;
  let issue = 'This action cannot be edited here. Your saved change is retained.';
  if (expenseCommand) {
    try {
      if (typeof body.id !== 'string' || !body.id || typeof body.description !== 'string'
        || !body.description.trim() || body.description.length > 200 || typeof body.date !== 'string'
        || !/^\d{4}-\d{2}-\d{2}$/.test(body.date) || Number.isNaN(Date.parse(body.date))
        || new Date(body.date).toISOString().slice(0, 10) !== body.date) throw new Error('Incomplete expense');
      const vectors = validateExpense(body.total as string, body.paid as Amounts, body.split as Split,
        group.participants.map(person => person.id));
      saved = {
        id: body.id, description: body.description, total: body.total as string, date: body.date,
        ...vectors, split: body.split as Split, version: current?.version ?? 0, deleted: false,
        category: typeof body.category === 'string' ? body.category : 'other',
        notes: typeof body.notes === 'string' ? body.notes : '',
      };
      issue = '';
    } catch {
      issue = 'Incomplete people, amounts or date. Your saved change is retained.';
    }
  }
  const canEdit = !!saved && (creating ? !current : updating && !!current && !current.deleted);

  function editSaved() {
    if (busy || !canEdit || !saved) return;
    onEditSaved(saved);
  }

  return <View style={s.content}>
    <Text style={ui.caption}>{group.name}</Text>
    {!expenseCommand && <Text style={[ui.notice, ui.warning]}>This change has not synced.</Text>}
    <View style={s.section}>
      <Text accessibilityRole="header" style={ui.section}>Your change</Text>
      {saved ? <SavedBillSummary expense={saved} participants={group.participants} /> : <Text accessibilityRole="alert" style={ui.body}>{issue}</Text>}
    </View>
    {expenseCommand && <>
      <View style={s.section}>
        <Text accessibilityRole="header" style={ui.section}>Latest</Text>
        {current ? <SavedBillSummary expense={current} participants={group.participants} /> : <Text style={ui.body}>This bill is not in the group's latest records.</Text>}
      </View>
      {creating && current && <Text style={[ui.notice, ui.warning]}>This bill already exists. Your saved change will not overwrite it.</Text>}
      {updating && current?.deleted && <Text style={[ui.notice, ui.warning]}>Restore the latest bill before editing it.</Text>}
      {updating && !current && <Text style={[ui.notice, ui.warning]}>This bill is unavailable. Your saved change will not recreate it.</Text>}
    </>}
    <View style={s.section}>
      {canEdit && <Button title="Edit your change" kind="primary" disabled={busy} onPress={editSaved} />}
      <Button title="Discard saved change" kind="text" disabled={busy} onPress={onDiscard} />
    </View>
  </View>;
}

const makeStyles = (colors: Palette) => StyleSheet.create({
  content: { gap: 14 },
  section: { gap: 12 },
  bill: { backgroundColor: colors.surface, borderRadius: radii.surface, padding: 12, gap: 10 },
  person: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  name: { fontSize: 16, lineHeight: 23, color: colors.text, flex: 1, minWidth: 0 },
  amount: { fontSize: 16, lineHeight: 23, color: colors.text, fontWeight: '500', textAlign: 'right', flexShrink: 0, fontVariant: ['tabular-nums'] },
});
