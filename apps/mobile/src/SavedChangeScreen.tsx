import React from 'react';
import { Alert, Button, Text, View } from 'react-native';
import { formatMoney, validateExpense } from './accounting';
import type { Amounts, Split } from './accounting';
import type { Command, Expense, Group } from './types';

type Props = {
  command: Command; group: Group; busy: boolean;
  onDiscard: () => void; onEditSaved: (expense: Expense) => void;
};

export default function SavedChangeScreen({ command, group, busy, onDiscard, onEditSaved }: Props) {
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
    return <View style={{ gap: 6 }}>
      <Text>{expense.description}</Text>
      <Text>{formatMoney(expense.total)} · {expense.date}</Text>
      {expense.deleted && <Text>Deleted. This expense is not included in balances.</Text>}
      {group.participants.filter(person => (expense.paid[person.id] ?? '0') !== '0'
        || (expense.shares[person.id] ?? '0') !== '0').map(person => <Text key={person.id}>
        {person.name} paid {formatMoney(expense.paid[person.id] ?? '0')}; share {formatMoney(expense.shares[person.id] ?? '0')}
      </Text>)}
      {!!expense.notes && <Text>{expense.notes}</Text>}
    </View>;
  }

  function editSaved() {
    if (busy || !canEdit || !saved) return;
    const expense = saved;
    Alert.alert('Edit your saved change?',
      'Compare your saved values with the accepted expense above. This opens your saved values for review. Nothing changes until you save.',
      [{ text: 'Cancel', style: 'cancel' }, { text: 'Edit saved change', onPress: () => onEditSaved(expense) }]);
  }

  return <View style={{ gap: 16 }}>
    <Text>The saved change is still on this device. Compare it with accepted records before editing.</Text>
    <Text style={{ fontSize: 18, fontWeight: '600' }}>{expenseCommand ? 'Your saved expense' : 'Your saved change'}</Text>
    {saved ? summary(saved) : <Text>{issue}</Text>}
    {expenseCommand && <>
      <Text style={{ fontSize: 18, fontWeight: '600' }}>Current accepted expense</Text>
      {current ? summary(current) : <Text>This expense is not in the accepted group records.</Text>}
      {creating && current && <Text>This expense already exists in accepted records and will not be overwritten here. Leave this change saved or discard it below.</Text>}
      {updating && current?.deleted && <Text>Restore the accepted expense before editing it.</Text>}
      {updating && !current && <Text>The accepted expense is no longer available. This saved change will not recreate it automatically.</Text>}
    </>}
    {canEdit && <Button title="Edit my saved change" disabled={busy} onPress={editSaved} />}
    <Button title="Keep accepted records and discard this change" disabled={busy} onPress={onDiscard} />
  </View>;
}
