import React, { useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import * as Crypto from 'expo-crypto';
import { integer, rupeesToPaise, validateExpense } from './accounting';
import type { Amounts, Split } from './accounting';
import type { Expense, Group } from './types';

export type ExpenseFormDraft = {
  schemaVersion: 1; groupId: string; expenseId: string | null; id: string; expenseVersion: number;
  description: string; amount: string; date: string; notes: string;
  payerIds: string[]; payerAmounts: Record<string, string>; mode: Split['mode'];
  participantIds: string[]; splitValues: Record<string, string>;
};
export type LegacyExpenseDraft = {
  description: string; amount: string; paid: string; mode: Split['mode']; values: string;
  date: string; notes: string; editing: Expense | null;
};
type Props = {
  group: Group; expense?: Expense; selfId: string; busy: boolean;
  onSave: (expense: Expense) => Promise<void>; onCancel: () => void;
  initialDraft?: ExpenseFormDraft | LegacyExpenseDraft | null;
  onDraftChange?: (draft: ExpenseFormDraft) => void;
};

const today = () => { const date = new Date(); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; };
const rupees = (value: string) => { const amount = integer(value); return `${amount / 100n}.${(amount % 100n).toString().padStart(2, '0')}`; };
const paise = (value: string) => ['0', '0.0', '0.00'].includes(value) ? '0' : rupeesToPaise(value);

function startingDraft(group: Group, expense: Expense | undefined, selfId: string, saved: Props['initialDraft']): { draft: ExpenseFormDraft; warning: string } {
  const ids = group.participants.map(person => person.id);
  const payer = ids.includes(selfId) ? selfId : ids[0];
  const base: ExpenseFormDraft = {
    schemaVersion: 1, groupId: group.id, expenseId: expense?.id ?? null, id: expense?.id ?? Crypto.randomUUID(), expenseVersion: expense?.version ?? 0,
    description: expense?.description ?? '', amount: expense ? rupees(expense.total) : '', date: expense?.date ?? today(), notes: expense?.notes ?? '',
    payerIds: expense ? ids.filter(id => integer(expense.paid[id] ?? '0') > 0n) : payer ? [payer] : [],
    payerAmounts: expense ? Object.fromEntries(ids.map(id => [id, rupees(expense.paid[id] ?? '0')])) : {},
    mode: expense?.split.mode ?? 'equal', participantIds: expense ? Object.keys(expense.split.values) : ids,
    splitValues: expense ? Object.fromEntries(Object.entries(expense.split.values).map(([id, value]) => [id, expense.split.mode === 'exact' ? rupees(value) : value])) : {},
  };
  if (!saved) return { draft: base, warning: '' };
  if ('schemaVersion' in saved) {
    if (saved.schemaVersion === 1 && saved.groupId === group.id && saved.expenseId === (expense?.id ?? null)
      && saved.payerIds.every(id => ids.includes(id)) && saved.participantIds.every(id => ids.includes(id))) return { draft: saved, warning: '' };
    return { draft: base, warning: 'This saved draft belongs to a different expense. Please review the new form.' };
  }
  if ((saved.editing?.id ?? null) !== (expense?.id ?? null) || (saved.editing && !group.expenses.some(row => row.id === saved.editing!.id))) {
    return { draft: base, warning: 'This older draft belongs to a different expense. Please review the new form.' };
  }
  const text = { description: saved.description, amount: saved.amount, date: saved.date, notes: saved.notes };
  try {
    const paid = JSON.parse(saved.paid) as Amounts, values = JSON.parse(saved.values) as Amounts;
    for (const vector of [paid, values]) if (!vector || typeof vector !== 'object' || Array.isArray(vector) || Object.keys(vector).some(id => !ids.includes(id))) throw new Error('Incomplete people selection');
    return { draft: {
      ...base, ...text, expenseVersion: saved.editing?.version ?? base.expenseVersion, mode: saved.mode,
      payerIds: Object.keys(paid).length ? Object.keys(paid).filter(id => integer(paid[id]) > 0n) : base.payerIds,
      payerAmounts: Object.fromEntries(Object.entries(paid).map(([id, value]) => [id, rupees(value)])),
      participantIds: Object.keys(values), splitValues: Object.fromEntries(Object.entries(values).map(([id, value]) => [id, saved.mode === 'exact' ? rupees(value) : value])),
    }, warning: '' };
  } catch {
    return { draft: { ...base, ...text }, warning: 'This older draft had an incomplete split. Check the people and amounts before saving.' };
  }
}

function Field({ label, value, onChange, decimal = false, multiline = false, maxLength, disabled = false }: {
  label: string; value: string; onChange: (value: string) => void; decimal?: boolean; multiline?: boolean; maxLength?: number; disabled?: boolean;
}) {
  return <View style={styles.field}><Text>{label}</Text><TextInput accessibilityLabel={label} value={value} onChangeText={onChange}
    keyboardType={decimal ? 'decimal-pad' : 'default'} autoCorrect={false} multiline={multiline} maxLength={maxLength} editable={!disabled}
    style={[styles.input, multiline && styles.notes]} /></View>;
}
function Choice({ title, selected, disabled, onPress, role = 'checkbox' }: { title: string; selected: boolean; disabled: boolean; onPress: () => void; role?: 'checkbox' | 'radio' }) {
  return <Pressable accessibilityRole={role} accessibilityLabel={title} accessibilityState={{ checked: selected, disabled }} disabled={disabled}
    onPress={onPress} style={[styles.control, selected && styles.selected]}><Text>{selected ? '✓ ' : ''}{title}</Text></Pressable>;
}

export default function ExpenseForm({ group, expense, selfId, busy, onSave, onCancel, initialDraft, onDraftChange }: Props) {
  const [restored] = useState(() => startingDraft(group, expense, selfId, initialDraft));
  const [draft, setDraft] = useState(restored.draft), [error, setError] = useState(restored.warning), [saving, setSaving] = useState(false);
  const lock = useRef(false), disabled = busy || saving;
  const label = (id: string) => {
    const person = group.participants.find(value => value.id === id)!;
    const matching = group.participants.filter(value => value.name === person.name);
    return `${person.name}${matching.length > 1 ? ` (${matching.findIndex(value => value.id === id) + 1})` : ''}${id === selfId ? ' (you)' : ''}`;
  };
  function change(patch: Partial<ExpenseFormDraft>) {
    const next = { ...draft, ...patch }; setDraft(next); setError(''); onDraftChange?.(next);
  }
  function togglePayer(id: string) {
    const payerIds = draft.payerIds.includes(id) ? draft.payerIds.filter(value => value !== id) : [...draft.payerIds, id];
    const payerAmounts = { ...draft.payerAmounts };
    if (draft.payerIds.length === 1) payerAmounts[draft.payerIds[0]] = draft.amount;
    change({ payerIds, payerAmounts });
  }
  async function save() {
    if (lock.current || busy) return;
    setError('');
    try {
      if (!draft.description.trim() || draft.description.trim().length > 200) throw new Error('Enter a description of up to 200 characters.');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.date) || Number.isNaN(Date.parse(draft.date)) || new Date(draft.date).toISOString().slice(0, 10) !== draft.date) throw new Error('Enter a valid date in YYYY-MM-DD format.');
      if (draft.notes.length > 2000) throw new Error('Notes can contain up to 2,000 characters.');
      const total = rupeesToPaise(draft.amount);
      if (!draft.payerIds.length) throw new Error('Choose someone who paid.');
      if (!draft.participantIds.length) throw new Error('Choose someone to share this expense.');
      const paid = Object.fromEntries(draft.payerIds.map(id => [id, draft.payerIds.length === 1 ? total : paise(draft.payerAmounts[id] ?? '')]));
      const split: Split = { mode: draft.mode, values: Object.fromEntries(draft.participantIds.map(id => [id,
        draft.mode === 'equal' ? '1' : draft.mode === 'exact' ? paise(draft.splitValues[id] ?? '') : draft.splitValues[id] ?? '',
      ])) };
      const vectors = validateExpense(total, paid, split, group.participants.map(person => person.id));
      lock.current = true; setSaving(true);
      await onSave({ id: draft.id, version: draft.expenseVersion, description: draft.description.trim(), total, ...vectors, split,
        date: draft.date, notes: draft.notes, category: expense?.category ?? 'general', deleted: false });
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save the expense. Try again.'); }
    finally { lock.current = false; setSaving(false); }
  }
  return <View style={styles.form}>
    <Text style={styles.heading}>{expense ? 'Edit expense' : 'Add expense'}</Text>
    {expense && expense.version !== draft.expenseVersion && <Text>A newer edit exists. Review it before saving this older draft.</Text>}
    <Field label="Description" value={draft.description} onChange={description => change({ description })} maxLength={200} disabled={disabled} />
    <Field label="Amount (₹)" value={draft.amount} onChange={amount => change({ amount })} decimal disabled={disabled} />
    <Text style={styles.section}>Paid by</Text><Text>Select one or more people. A single payer covers the whole bill.</Text>
    {group.participants.map(person => <View key={`payer-${person.id}`} style={styles.field}>
      <Choice title={label(person.id)} selected={draft.payerIds.includes(person.id)} disabled={disabled} onPress={() => togglePayer(person.id)} />
      {draft.payerIds.length > 1 && draft.payerIds.includes(person.id) && <Field label={`Paid by ${label(person.id)} (₹)`} value={draft.payerAmounts[person.id] ?? ''}
        onChange={value => change({ payerAmounts: { ...draft.payerAmounts, [person.id]: value } })} decimal disabled={disabled} />}
    </View>)}
    <Text style={styles.section}>Split between</Text>
    {group.participants.map(person => <Choice key={`share-${person.id}`} title={label(person.id)} selected={draft.participantIds.includes(person.id)} disabled={disabled}
      onPress={() => change({ participantIds: draft.participantIds.includes(person.id) ? draft.participantIds.filter(id => id !== person.id) : [...draft.participantIds, person.id] })} />)}
    <Text style={styles.section}>How to split</Text>
    {([['equal', 'Equally'], ['exact', 'Exact amounts'], ['percent', 'Percentages'], ['shares', 'Shares']] as const).map(([mode, title]) =>
      <Choice key={mode} title={title} role="radio" selected={draft.mode === mode} disabled={disabled} onPress={() => {
        if (draft.mode !== mode) change({ mode, splitValues: Object.fromEntries(draft.participantIds.map(id => [id, mode === 'shares' ? '1' : ''])) });
      }} />)}
    {draft.mode !== 'equal' && <>
      <Text>{draft.mode === 'exact' ? 'Amounts must add up to the bill.' : draft.mode === 'percent' ? 'Percentages must add up to 100.' : 'For example, 2 shares receives twice as much as 1 share.'}</Text>
      {group.participants.filter(person => draft.participantIds.includes(person.id)).map(person => <Field key={`value-${person.id}`}
        label={`${label(person.id)} ${draft.mode === 'exact' ? '(₹)' : draft.mode === 'percent' ? '(%)' : '(shares)'}`} value={draft.splitValues[person.id] ?? ''}
        onChange={value => change({ splitValues: { ...draft.splitValues, [person.id]: value } })} decimal disabled={disabled} />)}
    </>}
    <Field label="Date (YYYY-MM-DD)" value={draft.date} onChange={date => change({ date })} maxLength={10} disabled={disabled} />
    <Field label="Notes (optional)" value={draft.notes} onChange={notes => change({ notes })} multiline maxLength={2000} disabled={disabled} />
    {!!error && <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={styles.error}>{error}</Text>}
    <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={() => void save()} style={[styles.control, styles.primary]}><Text style={styles.primaryText}>{saving ? 'Saving…' : 'Save expense'}</Text></Pressable>
    <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onCancel} style={styles.control}><Text>Cancel</Text></Pressable>
  </View>;
}

const styles = StyleSheet.create({
  form: { gap: 12 }, field: { gap: 6 }, heading: { fontSize: 22, fontWeight: '600' }, section: { fontSize: 17, fontWeight: '600', marginTop: 8 },
  input: { minHeight: 44, borderWidth: 1, borderColor: '#888', padding: 10, color: '#111', fontSize: 16 }, notes: { minHeight: 80, textAlignVertical: 'top' },
  control: { minHeight: 44, borderWidth: 1, borderColor: '#888', padding: 12, justifyContent: 'center' }, selected: { backgroundColor: '#eee' },
  primary: { backgroundColor: '#111' }, primaryText: { color: 'white', fontWeight: '600', textAlign: 'center' }, error: { color: '#a11919' },
});
