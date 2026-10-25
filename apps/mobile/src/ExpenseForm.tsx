import Form from './Form';
import React, { useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Checkbox, Text } from 'react-native-paper';
import * as Crypto from 'expo-crypto';
import { formatMoney, integer, rupeesToPaise, validateExpense } from './accounting';
import type { Amounts, Split } from './accounting';
import type { Expense, Group } from './types';
import { Button, DateField, ErrorText, useUI } from './ui';
import { AmountField, RadioChoice, TextField } from './FormFields';
import DraftAttachment from './DraftAttachment';
import type { PendingMediaUpload } from './media';
import BillPeople from './BillPeople';

export type ExpenseFormDraft = {
  schemaVersion: 1; groupId: string; expenseId: string | null; id: string; expenseVersion: number;
  description: string; amount: string; date: string; notes: string;
  payerIds: string[]; payerAmounts: Record<string, string>; mode: Split['mode'];
  attachment?: PendingMediaUpload; participantIds: string[]; splitValues: Record<string, string>;
};
export type LegacyExpenseDraft = {
  description: string; amount: string; paid: string; mode: Split['mode']; values: string;
  date: string; notes: string; editing: Expense | null;
};
type Props = {
  group: Group; expense?: Expense; selfId: string; busy: boolean;
  onSave: (expense: Expense, attachment?: PendingMediaUpload) => Promise<void>; onCancel: () => void;
  initialDraft?: ExpenseFormDraft | LegacyExpenseDraft | null;
  onDraftChange?: (draft: ExpenseFormDraft) => void | Promise<void>;
};

const today = () => { const date = new Date(); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; };
const rupees = (value: string) => { const amount = integer(value); return `${amount / 100n}.${(amount % 100n).toString().padStart(2, '0')}`; };
const paise = (value: string) => ['0', '0.0', '0.00'].includes(value) ? '0' : rupeesToPaise(value);

function startingDraft(group: Group, expense: Expense | undefined, selfId: string, saved: Props['initialDraft']): { draft: ExpenseFormDraft; warning: string } {
  const ids = group.participants.map(person => person.id);
  const activeIds = group.participants.filter(person => !person.removed).map(person => person.id);
  const payer = activeIds.includes(selfId) ? selfId : activeIds[0];
  const base: ExpenseFormDraft = {
    schemaVersion: 1, groupId: group.id, expenseId: expense?.id ?? null, id: expense?.id ?? Crypto.randomUUID(), expenseVersion: expense?.version ?? 0,
    description: expense?.description ?? '', amount: expense ? rupees(expense.total) : '', date: expense?.date ?? today(), notes: expense?.notes ?? '',
    payerIds: expense ? ids.filter(id => integer(expense.paid[id] ?? '0') > 0n) : payer ? [payer] : [],
    payerAmounts: expense ? Object.fromEntries(ids.map(id => [id, rupees(expense.paid[id] ?? '0')])) : {},
    mode: expense?.split.mode ?? 'equal', participantIds: expense ? Object.keys(expense.split.values) : activeIds,
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

function Choice({ title, selected, disabled, onPress, role = 'checkbox' }: { title: string; selected: boolean; disabled: boolean; onPress: () => void; role?: 'checkbox' | 'radio' }) {
  const { ui } = useUI();
  return role === 'radio'
    ? <RadioChoice label={title} value={title} selected={selected} disabled={disabled} onPress={onPress} />
    : <Checkbox.Item label={title} status={selected ? 'checked' : 'unchecked'} disabled={disabled} onPress={onPress} accessibilityLabel={title} labelStyle={ui.body} mode="android" />;
}

type ExpenseSelectionProps = {
  participants: Group['participants']; draft: ExpenseFormDraft; disabled: boolean; preserveRemoved: boolean;
  label: (id: string) => string; onChange: (patch: Partial<ExpenseFormDraft>) => void; status: string;
};
const splitModes = { equal: 'Equally', exact: 'Exact amounts', percent: 'Percentages', shares: 'Shares' } as const;

function PayerFields({ participants, draft, disabled, preserveRemoved, label, onChange, status, onToggle }: ExpenseSelectionProps & { onToggle: (id: string) => void }) {
  const { ui } = useUI();
  return <View style={styles.reveal}>
    {participants.filter(person => !person.removed || draft.payerIds.includes(person.id)).map(person => <View key={`payer-${person.id}`} style={styles.field}>
      <Choice title={label(person.id)} selected={draft.payerIds.includes(person.id)} disabled={disabled || (preserveRemoved && !!person.removed)} onPress={() => onToggle(person.id)} />
      {draft.payerIds.length > 1 && draft.payerIds.includes(person.id) && <TextField autoCorrect={false} label={`Paid by ${label(person.id)} (₹)`} value={draft.payerAmounts[person.id] ?? ''}
        onChangeText={value => onChange({ payerAmounts: { ...draft.payerAmounts, [person.id]: value } })} keyboardType="decimal-pad" editable={!disabled && !person.removed} />}
    </View>)}
    {!!status && <Text accessibilityLiveRegion="polite" style={ui.caption}>{status}</Text>}
  </View>;
}

function SplitFields({ participants, draft, disabled, preserveRemoved, label, onChange, status }: ExpenseSelectionProps) {
  const { ui } = useUI();
  return <View style={styles.reveal}>
    {participants.filter(person => !person.removed || draft.participantIds.includes(person.id)).map(person => <Choice key={`share-${person.id}`} title={label(person.id)} selected={draft.participantIds.includes(person.id)} disabled={disabled || (preserveRemoved && !!person.removed)}
      onPress={() => onChange({ participantIds: draft.participantIds.includes(person.id) ? draft.participantIds.filter(id => id !== person.id) : [...draft.participantIds, person.id] })} />)}
    <Text style={ui.label}>Split method</Text>
    {Object.entries(splitModes).map(([mode, title]) => <Choice key={mode} title={title} role="radio" selected={draft.mode === mode} disabled={disabled} onPress={() => {
      if (draft.mode !== mode) onChange({ mode: mode as Split['mode'], splitValues: Object.fromEntries(draft.participantIds.map(id => [id, mode === 'shares' ? '1' : ''])) });
    }} />)}
    {draft.mode !== 'equal' && <>
      {participants.filter(person => draft.participantIds.includes(person.id)).map(person => <TextField autoCorrect={false} key={`value-${person.id}`}
        label={`${label(person.id)} ${draft.mode === 'exact' ? '(₹)' : draft.mode === 'percent' ? '(%)' : '(shares)'}`} value={draft.splitValues[person.id] ?? ''}
        onChangeText={value => onChange({ splitValues: { ...draft.splitValues, [person.id]: value } })} keyboardType="decimal-pad" editable={!disabled && !person.removed} />)}
      {!!status && <Text accessibilityLiveRegion="polite" style={ui.caption}>{status}</Text>}
    </>}
  </View>;
}

export default function ExpenseForm({ group, expense, selfId, busy, onSave, initialDraft, onDraftChange }: Props) {
  const { ui } = useUI();
  const [restored] = useState(() => startingDraft(group, expense, selfId, initialDraft));
  const [draft, setDraft] = useState(restored.draft), [error, setError] = useState(restored.warning), [saving, setSaving] = useState(false);
  const [fileBusy, setFileBusy] = useState(false);
  const draftRef = useRef(draft);
  const lock = useRef(false), disabled = busy || saving || fileBusy;
  const acceptedExpense = group.expenses.find(value => value.id === draft.id);
  const label = (id: string) => {
    const person = group.participants.find(value => value.id === id)!;
    const matching = group.participants.filter(value => value.name === person.name);
    return `${person.name}${person.removed ? ' (removed)' : ''}${matching.length > 1 ? ` (${matching.findIndex(value => value.id === id) + 1})` : ''}${id === selfId && person.name.trim().toLowerCase() !== 'you' ? ' (you)' : ''}`;
  };
  async function persistChange(patch: Partial<ExpenseFormDraft>) {
    const previous = draftRef.current, next = { ...previous, ...patch };
    draftRef.current = next; setDraft(next); setError('');
    try { await onDraftChange?.(next); }
    catch (error) { if ('attachment' in patch) { draftRef.current = previous; setDraft(previous); } throw error; }
  }
  function change(patch: Partial<ExpenseFormDraft>) { void persistChange(patch).catch(error => setError(error.message)); }
  function togglePayer(id: string) {
    const payerIds = draft.payerIds.includes(id) ? draft.payerIds.filter(value => value !== id) : [...draft.payerIds, id];
    const payerAmounts = { ...draft.payerAmounts };
    if (draft.payerIds.length === 1) payerAmounts[draft.payerIds[0]] = draft.amount;
    change({ payerIds, payerAmounts });
  }
  async function save() {
    if (lock.current || busy || fileBusy || group.archived) return;
    setError('');
    try {
      if (!draft.description.trim() || draft.description.trim().length > 200) throw new Error('Enter a description of up to 200 characters.');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.date) || Number.isNaN(Date.parse(draft.date)) || new Date(draft.date).toISOString().slice(0, 10) !== draft.date) throw new Error('Choose a valid date.');
      if (draft.notes.length > 2000) throw new Error('Notes can contain up to 2,000 characters.');
      const total = rupeesToPaise(draft.amount);
      if (!draft.payerIds.length) throw new Error('Choose someone who paid.');
      const paid = Object.fromEntries(draft.payerIds.map(id => [id, draft.payerIds.length === 1 ? total : paise(draft.payerAmounts[id] ?? '')]));
      if (!draft.participantIds.length) throw new Error('Choose someone to share this expense.');
      const split: Split = { mode: draft.mode, values: Object.fromEntries(draft.participantIds.map(id => [id,
        draft.mode === 'equal' ? '1' : draft.mode === 'exact' ? paise(draft.splitValues[id] ?? '') : draft.splitValues[id] ?? '',
      ])) };
      const vectors = validateExpense(total, paid, split, group.participants.filter(person => acceptedExpense || !person.removed).map(person => person.id));
      if (group.participants.some(person => person.removed &&
        (BigInt(vectors.paid[person.id] ?? '0') !== BigInt(acceptedExpense?.paid[person.id] ?? '0') ||
          BigInt(vectors.shares[person.id] ?? '0') !== BigInt(acceptedExpense?.shares[person.id] ?? '0')))) {
        throw new Error('Keep removed people’s paid amounts and shares unchanged.');
      }
      lock.current = true; setSaving(true);
      await onDraftChange?.(draft);
      await onSave({ id: draft.id, version: draft.expenseVersion, description: draft.description.trim(), total, ...vectors, split,
        date: draft.date, notes: draft.notes, category: expense?.category ?? 'general', category_auto: expense?.category_auto ?? ['', 'general', 'other'].includes((expense?.category ?? '').trim().toLowerCase()), deleted: false }, draft.attachment);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Could not save the expense. Try again.';
      setError(message);
    }
    finally { lock.current = false; setSaving(false); }
  }
  const people = draft.participantIds.map(label);
  const between = people.length ? `${people.length === group.participants.filter(person => !person.removed).length && !draft.participantIds.some(id => group.participants.find(person => person.id === id)?.removed) ? 'Everyone' : `${people.length} people`} · ${splitModes[draft.mode].toLowerCase()}` : 'Choose people';
  let splitStatus = '', payerStatus = '';
  try {
    if (draft.mode === 'exact' || draft.mode === 'percent') {
      const sum = draft.participantIds.reduce((value, id) => value + integer(paise(draft.splitValues[id] || '0')), 0n);
      const target = draft.mode === 'percent' ? 10_000n : integer(rupeesToPaise(draft.amount));
      const difference = target - sum, absolute = (difference < 0n ? -difference : difference).toString();
      const display = draft.mode === 'percent' ? `${rupees(absolute)}%` : formatMoney(absolute);
      splitStatus = difference === 0n ? 'Adds up.' : `${display} ${difference > 0n ? 'left to split' : 'too much'}.`;
    }
    if (draft.payerIds.length > 1) {
      const sum = draft.payerIds.reduce((value, id) => value + integer(paise(draft.payerAmounts[id] || '0')), 0n);
      const difference = integer(rupeesToPaise(draft.amount)) - sum;
      payerStatus = difference === 0n ? 'Adds up to the bill.' : `${formatMoney((difference < 0n ? -difference : difference).toString())} ${difference > 0n ? 'still to add' : 'too much'}.`;
    }
  } catch { /* The save action keeps the existing accounting validation authoritative. */ }
  return <Form label="Bill" style={styles.form} onSubmit={() => { if (!disabled && !group.archived) void save(); }}>
    <Text style={ui.caption}>{group.name}</Text>
    {group.archived && <Text style={ui.notice}>Reopen this group in settings before saving a bill.</Text>}
    {expense && expense.version !== draft.expenseVersion && <Text style={ui.notice}>A newer edit exists. Review it before saving this older draft.</Text>}
    <AmountField autoCorrect={false} label="Amount (₹)" value={draft.amount} onChangeText={amount => change({ amount })} placeholder="0" editable={!disabled} />
    <TextField autoCorrect={false} label="Description" value={draft.description} onChangeText={description => change({ description })} placeholder="What was it for?" maxLength={200} editable={!disabled} />
    <BillPeople icon="pay" title="Who paid?" summary={draft.payerIds.length === 1 ? label(draft.payerIds[0]) : draft.payerIds.length ? `${draft.payerIds.length} people` : 'Choose who paid'}
      inline={group.participants.filter(person => !person.removed || draft.payerIds.includes(person.id)).length === 1} disabled={disabled}>
      <PayerFields participants={group.participants} draft={draft} disabled={disabled} preserveRemoved={!!acceptedExpense}
        label={label} onChange={change} status={payerStatus} onToggle={togglePayer} />
    </BillPeople>
    <BillPeople icon="people" title="Split between" summary={between} inline={group.participants.filter(person => !person.removed || draft.participantIds.includes(person.id)).length === 1} disabled={disabled}>
      <SplitFields participants={group.participants} draft={draft} disabled={disabled} preserveRemoved={!!acceptedExpense}
        label={label} onChange={change} status={splitStatus} />
    </BillPeople>
    <DateField label="Date" value={draft.date} onChange={date => change({ date })} disabled={disabled} />
    <TextField autoCorrect={false} label="Notes (optional)" value={draft.notes} onChangeText={notes => change({ notes })} multiline style={styles.notes} maxLength={2000} editable={!disabled} />
    {!expense && <DraftAttachment value={draft.attachment} path={`/groups/${group.id}/expenses/${draft.id}/attachments`} disabled={disabled || !!group.archived} onChange={attachment => persistChange({ attachment })} onBusy={setFileBusy} onError={setError} />}
    {!!error && <ErrorText live>{error}</ErrorText>}
    <Button title={saving ? 'Saving…' : 'Save bill'} onPress={() => void save()} disabled={disabled || group.archived} kind="primary" icon="check" />
  </Form>;
}

const styles = StyleSheet.create({
  form: { gap: 12 }, field: { gap: 7 },
  notes: { minHeight: 100, textAlignVertical: 'top' }, reveal: { gap: 12, paddingBottom: 12 },
});
