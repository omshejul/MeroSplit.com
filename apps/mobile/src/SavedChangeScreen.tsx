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

export default function SavedChangeScreen({ command, group, busy, onDiscard, onEditSaved }: Props) {
  const { palette: colors, ui } = useUI();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const body = command.body;
  const current = group.expenses.find(expense => expense.id === body.id);
  const path = `/groups/${group.id}/expenses`;
  const creating = command.method === 'POST' && command.path === path;
  const updating = command.method === 'PUT' && command.path === `${path}/${body.id}`;
  const expenseCommand = command.group_id === group.id && (creating || updating);
  let saved: Expense | undefined;
  let issue = 'This saved action cannot be edited here. It remains saved until you discard it.';
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
      issue = 'This saved expense has incomplete people, amounts or dates. It remains saved until you discard it.';
    }
  }
  const canEdit = !!saved && (creating ? !current : updating && !!current && !current.deleted);

  function summary(expense: Expense) {
    return <View style={s.bill}>
      <Text style={ui.section}>{expense.description}</Text>
      <Text style={ui.numeric}>{formatMoney(expense.total)}</Text>
      <Text style={ui.caption}>{expense.date}</Text>
      {expense.deleted && <Text style={ui.notice}>Deleted. This bill is not included in balances.</Text>}
      <Text style={ui.label}>Who paid?</Text>
      {group.participants.filter(person => (expense.paid[person.id] ?? '0') !== '0').map(person => <View key={person.id} style={s.person}>
        <Text style={s.name}>{person.name}</Text><Text style={s.amount}>{formatMoney(expense.paid[person.id])}</Text>
      </View>)}
      <Text style={ui.label}>Split between</Text>
      {group.participants.filter(person => Object.hasOwn(expense.split.values, person.id)).map(person => <View key={person.id} style={s.person}>
        <Text style={s.name}>{person.name}</Text><Text style={s.amount}>{formatMoney(expense.shares[person.id] ?? '0')}</Text>
      </View>)}
      {!!expense.notes && <Text style={ui.caption}>{expense.notes}</Text>}
    </View>;
  }

  function editSaved() {
    if (busy || !canEdit || !saved) return;
    onEditSaved(saved);
  }

  return <View style={s.content}>
    <Text style={ui.caption}>{group.name}</Text>
    <Text style={ui.notice}>{expenseCommand ? 'Your change is saved on this phone. Compare both versions before choosing what to keep.' : 'This action is saved on this phone until it can be sent or you discard it.'}</Text>
    <View style={s.section}>
      <Text accessibilityRole="header" style={ui.section}>{expenseCommand ? 'My saved bill' : 'My saved change'}</Text>
      {saved ? summary(saved) : <Text accessibilityRole="alert" style={ui.body}>{issue}</Text>}
    </View>
    {expenseCommand && <>
      <View style={s.section}>
        <Text accessibilityRole="header" style={ui.section}>Latest bill</Text>
        {current ? summary(current) : <Text style={ui.body}>This bill is not in the group's latest records.</Text>}
      </View>
      {creating && current && <Text style={ui.notice}>This bill already exists and will not be overwritten here. Leave your change saved or discard it below.</Text>}
      {updating && current?.deleted && <Text style={ui.notice}>Restore the latest bill before editing it.</Text>}
      {updating && !current && <Text style={ui.notice}>The latest bill is no longer available. Your saved change will not recreate it automatically.</Text>}
    </>}
    <View style={s.section}>
      {canEdit && <Button title="Edit my bill" kind="primary" disabled={busy} onPress={editSaved} />}
      <Button title={expenseCommand ? 'Discard my saved bill' : 'Discard my saved change'} disabled={busy} onPress={onDiscard} />
      <Text style={ui.caption}>Discarding keeps the latest records as they are.</Text>
    </View>
  </View>;
}

const makeStyles = (colors: Palette) => StyleSheet.create({
  content: { gap: 14 },
  section: { gap: 12 },
  bill: { backgroundColor: colors.surface, borderRadius: radii.surface, padding: 12, gap: 10 },
  person: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  name: { fontSize: 16, lineHeight: 23, color: colors.text, flex: 1 },
  amount: { fontSize: 16, lineHeight: 23, color: colors.text, fontWeight: '500', textAlign: 'right', flexShrink: 1, fontVariant: ['tabular-nums'] },
});
