import PersonChoice from './PersonChoice';
import { NoticeBanner } from './UIStates';
import { animateLayout } from './layoutTransition';
import { currencySymbol } from './currency';
import Form from './Form';
import { ScreenDraftDiscard, useScreenRemovalLock } from './screenRemoval';
import React, { useContext, useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Text } from 'react-native-paper';
import * as Crypto from 'expo-crypto';
import { formatMoney, integer, rupeesToPaise, validateExpense } from './accounting';
import type { Split } from './accounting';
import type { Expense, Group } from './types';
import { Avatar, Button, DateField, ErrorText, Icon, useUI } from './ui';
import { AmountField, TextField } from './FormFields';
import DraftAttachment from './DraftAttachment';
import type { PendingMediaUpload } from './media';
import { clearStagedMedia } from './media';
import BillPeople from './BillPeople';
import { expenseDraftStore } from './expenseDraft';
import { getDatabase } from './native';

export type ExpenseFormDraft = {
  schemaVersion: 1; groupId: string; expenseId: string | null; id: string; expenseVersion: number;
  description: string; amount: string; date: string; notes: string;
  payerIds: string[]; payerAmounts: Record<string, string>; mode: Split['mode'];
  attachment?: PendingMediaUpload; participantIds: string[]; splitValues: Record<string, string>;
};
type Props = {
  group: Group; expense?: Expense; selfId: string; busy: boolean;
  owner: string; writes: { current: Promise<void> };
  onSave: (expense: Expense, attachment?: PendingMediaUpload, onQueued?: () => void) => Promise<void>;
};

const today = () => { const date = new Date(); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; };
const rupees = (value: string) => { const amount = integer(value); return `${amount / 100n}.${(amount % 100n).toString().padStart(2, '0')}`; };
const paise = (value: string) => ['0', '0.0', '0.00'].includes(value) ? '0' : rupeesToPaise(value);

function payerDifference(draft: ExpenseFormDraft): bigint | null {
  if (draft.payerIds.length < 2) return null;
  try {
    return integer(rupeesToPaise(draft.amount)) - draft.payerIds.reduce((sum, id) => sum + integer(paise(draft.payerAmounts[id] || '0')), 0n);
  } catch { return null; }
}

function startingDraft(group: Group, expense: Expense | undefined, selfId: string): ExpenseFormDraft {
  const ids = group.participants.map(person => person.id);
  const activeIds = group.participants.filter(person => !person.removed).map(person => person.id);
  const payer = activeIds.includes(selfId) ? selfId : activeIds[0];
  return {
    schemaVersion: 1, groupId: group.id, expenseId: expense?.id ?? null, id: expense?.id ?? Crypto.randomUUID(), expenseVersion: expense?.version ?? 0,
    description: expense?.description ?? '', amount: expense ? rupees(expense.total) : '', date: expense?.date ?? today(), notes: expense?.notes ?? '',
    payerIds: expense ? ids.filter(id => integer(expense.paid[id] ?? '0') > 0n) : payer ? [payer] : [],
    payerAmounts: expense ? Object.fromEntries(ids.map(id => [id, rupees(expense.paid[id] ?? '0')])) : {},
    mode: expense?.split.mode ?? 'equal', participantIds: expense ? Object.keys(expense.split.values) : activeIds,
    splitValues: expense ? Object.fromEntries(Object.entries(expense.split.values).map(([id, value]) => [id, expense.split.mode === 'exact' ? rupees(value) : value])) : {},
  };
}

type ExpenseSelectionProps = {
  participants: Group['participants']; draft: ExpenseFormDraft; disabled: boolean; preserveRemoved: boolean;
  label: (id: string) => string; onChange: (patch: Partial<ExpenseFormDraft>) => void; status: string;
};
const splitModes = { equal: 'Equally', exact: 'Exact amounts', percent: 'Percentages', shares: 'Shares' } as const;

function PayerAdjustment({ difference, name, onPress }: { difference: bigint; name: string; onPress: () => void }) {
  const { ui } = useUI(), adding = difference > 0n, amount = formatMoney((adding ? difference : -difference).toString());
  return <Button kind="plain" accessibilityRole="button" accessibilityLabel={`${adding ? 'Add' : 'Subtract'} ${amount} ${adding ? 'to' : 'from'} ${name}`} onPress={onPress} style={styles.adjustTouch}>
    <View style={[styles.adjustChip, { backgroundColor: adding ? '#4ADE80' : '#F87171' }]}>
      <Text style={[ui.caption, styles.adjustText, { color: adding ? '#052E16' : '#450A0A' }]}>{adding ? '+' : '−'}{amount}</Text>
    </View>
  </Button>;
}

function PayerFields({ participants, draft, disabled, preserveRemoved, label, onChange, status, onToggle, onAdjust }: ExpenseSelectionProps & { onToggle: (id: string) => void; onAdjust: (id: string) => void }) {
  const { ui, motion } = useUI();
  const difference = payerDifference(draft);
  return <View style={styles.reveal}>
    {participants.filter(person => !person.removed || draft.payerIds.includes(person.id)).map(person => <View key={`payer-${person.id}`} style={styles.field}>
      <PersonChoice person={person} title={label(person.id)} amount={draft.payerIds.length === 1 && draft.payerIds.includes(person.id) ? (() => { try { return formatMoney(rupeesToPaise(draft.amount)); } catch { return undefined; } })() : undefined} selected={draft.payerIds.includes(person.id)} disabled={disabled || (preserveRemoved && !!person.removed)} onPress={() => { animateLayout(!!motion?.enabled); onToggle(person.id); }} />
      {draft.payerIds.length > 1 && draft.payerIds.includes(person.id) && <TextField autoCorrect={false} label={`Paid by ${label(person.id)} (${currencySymbol()})`} value={draft.payerAmounts[person.id] ?? ''}
        onChangeText={value => onChange({ payerAmounts: { ...draft.payerAmounts, [person.id]: value } })} keyboardType="decimal-pad" editable={!disabled && !person.removed}
        right={!disabled && !person.removed && difference !== null && difference !== 0n && integer(paise(draft.payerAmounts[person.id] || '0')) + difference >= 0n
          ? <PayerAdjustment difference={difference} name={label(person.id)} onPress={() => onAdjust(person.id)} /> : null} />}
    </View>)}
    {!!status && <Text accessibilityLiveRegion="polite" style={ui.caption}>{status}</Text>}
  </View>;
}

function SplitFields({ participants, draft, disabled, preserveRemoved, label, onChange, status }: ExpenseSelectionProps) {
  const { ui, palette, motion } = useUI();
  let shares: Record<string, string> = {};
  try {
    const total = rupeesToPaise(draft.amount);
    const values = Object.fromEntries(draft.participantIds.map(id => [id, draft.mode === 'equal' ? '1' : draft.mode === 'exact' ? paise(draft.splitValues[id] ?? '') : draft.splitValues[id] ?? '']));
    shares = validateExpense(total, { [draft.participantIds[0]]: total }, { mode: draft.mode, values }, participants.map(person => person.id)).shares;
  } catch { /* Incomplete amounts stay editable without a misleading preview. */ }
  return <View style={styles.reveal}>
    <View accessibilityRole="radiogroup" accessibilityLabel="Split method" style={[styles.methods, { borderColor: palette.line }]}>
      {Object.entries(splitModes).map(([mode, title]) => <Button key={mode} title={title} kind="plain" accessibilityRole="radio" accessibilityState={{ checked: draft.mode === mode, disabled }} disabled={disabled}
        onPress={() => { if (draft.mode !== mode) { animateLayout(!!motion?.enabled); onChange({ mode: mode as Split['mode'], splitValues: Object.fromEntries(draft.participantIds.map(id => [id, mode === 'shares' ? '1' : ''])) }); } }}
        style={[styles.method, { backgroundColor: draft.mode === mode ? palette.soft : 'transparent' }]}>
        {mode === 'exact' ? <Text accessible={false} style={[ui.body, { color: draft.mode === mode ? palette.accent : palette.text, fontSize: 23, lineHeight: 28 }]}>{currencySymbol()}</Text>
          : <Icon name={mode === 'equal' ? 'equal' : mode === 'percent' ? 'percent' : 'shares'} size={23} color={draft.mode === mode ? palette.accent : palette.text} />}
        <Text style={[ui.caption, { color: draft.mode === mode ? palette.accent : palette.text, textAlign: 'center' }]}>{mode === 'equal' ? 'Equally' : mode === 'exact' ? 'Amounts' : mode === 'percent' ? 'Percent' : 'Shares'}</Text>
      </Button>)}
    </View>
    <Text style={ui.caption}>{!draft.participantIds.length ? 'Choose who to include.' : draft.mode === 'equal' ? `Split equally between ${draft.participantIds.length} ${draft.participantIds.length === 1 ? 'person' : 'people'}.` : draft.mode === 'exact' ? 'Enter what each person owes.' : draft.mode === 'percent' ? 'Enter each person’s percentage.' : 'Enter each person’s number of shares.'}</Text>
    {participants.filter(person => !person.removed || draft.participantIds.includes(person.id)).map(person => <View key={`share-${person.id}`} style={styles.field}>
      <PersonChoice person={person} amount={!draft.participantIds.includes(person.id) ? 'Not included' : shares[person.id] !== undefined ? formatMoney(shares[person.id]) : undefined} title={label(person.id)} selected={draft.participantIds.includes(person.id)} disabled={disabled || (preserveRemoved && !!person.removed)}
        onPress={() => { animateLayout(!!motion?.enabled); onChange({ participantIds: draft.participantIds.includes(person.id) ? draft.participantIds.filter(id => id !== person.id) : [...draft.participantIds, person.id] }); }} />
      {draft.mode !== 'equal' && draft.participantIds.includes(person.id) && <TextField autoCorrect={false}
        label={`${label(person.id)} ${draft.mode === 'exact' ? `(${currencySymbol()})` : draft.mode === 'percent' ? '(%)' : '(shares)'}`} value={draft.splitValues[person.id] ?? ''}
        onChangeText={value => onChange({ splitValues: { ...draft.splitValues, [person.id]: value } })} keyboardType="decimal-pad" editable={!disabled && !person.removed} />}
    </View>)}
    {draft.mode !== 'equal' && !!status && <Text accessibilityLiveRegion="polite" style={ui.caption}>{status}</Text>}
  </View>;
}

export default function ExpenseForm({ group, expense, selfId, busy, onSave, owner, writes }: Props) {
  const { ui } = useUI();
  const [draft, setDraft] = useState(() => startingDraft(group, expense, selfId)), [error, setError] = useState(''), [saving, setSaving] = useState(false);
  const [fileBusy, setFileBusy] = useState(false);
  const draftRef = useRef(draft);
  const handedOff = useRef(false), mounted = useRef(true), discard = useContext(ScreenDraftDiscard);
  const pendingSave = useRef<Promise<void> | null>(null);
  const [ready, setReady] = useState(false);
  const storage = useRef<ReturnType<typeof expenseDraftStore> | null>(null);
  if (!storage.current) storage.current = expenseDraftStore(owner, group.id, expense?.id ?? null, writes, getDatabase);
  const store = storage.current;
  useEffect(() => {
    mounted.current = true;
    void store.read().then(saved => {
      if (!mounted.current) return;
      if (saved) { draftRef.current = saved; setDraft(saved); }
      setReady(true);
    }).catch(() => { if (mounted.current) setError('Could not restore this saved bill. Your draft is still on this device.'); });
    const remove = async () => {
      if (handedOff.current) return true;
      if (lock.current) return false;
      lock.current = true;
      try {
        await store.write(null);
        if (draftRef.current.attachment) await clearStagedMedia(draftRef.current.attachment.file);
        return true;
      } catch { if (mounted.current) setError('Could not discard this draft. Try again.'); return false; }
      finally { lock.current = false; }
    };
    discard.current = remove;
    return () => { mounted.current = false; if (discard.current === remove) discard.current = null; };
  }, [store, discard]);
  const lock = useRef(false), disabled = !ready || busy || saving || fileBusy || handedOff.current;
  useScreenRemovalLock(saving || fileBusy);
  const acceptedExpense = group.expenses.find(value => value.id === draft.id);
  const label = (id: string) => {
    const person = group.participants.find(value => value.id === id)!;
    const matching = group.participants.filter(value => value.name === person.name);
    return `${person.name}${person.removed ? ' (removed)' : ''}${matching.length > 1 ? ` (${matching.findIndex(value => value.id === id) + 1})` : ''}${id === selfId && person.name.trim().toLowerCase() !== 'you' ? ' (you)' : ''}`;
  };
  function change(patch: Partial<ExpenseFormDraft>) {
    const next = { ...draftRef.current, ...patch };
    draftRef.current = next; setDraft(next); setError('');
    const pending = store.write(next);
    void pending.catch(() => { if (mounted.current && draftRef.current === next) setError('Could not save this draft on the device. Try again.'); });
    return pending;
  }
  function togglePayer(id: string) {
    const payerIds = draft.payerIds.includes(id) ? draft.payerIds.filter(value => value !== id) : [...draft.payerIds, id];
    const payerAmounts = { ...draft.payerAmounts };
    if (draft.payerIds.length === 1) payerAmounts[draft.payerIds[0]] = draft.amount;
    change({ payerIds, payerAmounts });
  }
  function adjustPayer(id: string) {
    const current = draftRef.current, difference = payerDifference(current);
    if (disabled || lock.current || group.archived || difference === null || difference === 0n || !current.payerIds.includes(id) || !group.participants.some(person => person.id === id && !person.removed)) return;
    const amount = integer(paise(current.payerAmounts[id] || '0')) + difference;
    if (amount >= 0n) change({ payerAmounts: { ...current.payerAmounts, [id]: rupees(amount.toString()) } });
  }
  async function save() {
    if (!ready || lock.current || busy || fileBusy || handedOff.current || group.archived) return;
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
      pendingSave.current = Promise.resolve().then(() => onSave({ id: draft.id, version: draft.expenseVersion, description: draft.description.trim(), total, ...vectors, split,
        date: draft.date, notes: draft.notes, category: expense?.category ?? 'general', category_auto: expense?.category_auto ?? ['', 'general', 'other'].includes((expense?.category ?? '').trim().toLowerCase()), deleted: false }, draft.attachment, () => { handedOff.current = true; void store.write(null).catch(() => {}); }));
      await pendingSave.current;
      handedOff.current = true;
      await store.write(null);
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
  } catch { /* The save action keeps the existing accounting validation authoritative. */ }
  const difference = payerDifference(draft);
  if (difference !== null) payerStatus = difference === 0n ? 'Adds up to the bill.' : `${formatMoney((difference < 0n ? -difference : difference).toString())} ${difference > 0n ? 'still to add' : 'too much'}.`;
  let formattedTotal: string | undefined;
  try { formattedTotal = formatMoney(rupeesToPaise(draft.amount)); } catch { /* Keep incomplete input editable. */ }
  return <Form label="Bill" style={styles.form} onSubmit={() => { if (!disabled && !group.archived) void save(); }}>
    <Text style={ui.caption}>{group.name}</Text>
    {group.archived && <NoticeBanner>Reopen this group in settings before saving a bill.</NoticeBanner>}
    {expense && expense.version !== draft.expenseVersion && <NoticeBanner>A newer edit exists. Review it before saving this older draft.</NoticeBanner>}
    <AmountField autoCorrect={false} label={`Amount (${currencySymbol()})`} value={draft.amount} onChangeText={amount => change({ amount })} placeholder="0" editable={!disabled} />
    <TextField autoCorrect={false} label="Description" value={draft.description} onChangeText={description => change({ description })} placeholder="What was it for?" maxLength={200} editable={!disabled} />
    <BillPeople total={formattedTotal} count={draft.payerIds.length} icon="pay" title="Who paid?" summary={draft.payerIds.length === 1 ? label(draft.payerIds[0]) : draft.payerIds.length ? `${draft.payerIds.length} people` : 'Choose who paid'}
      inline={group.participants.filter(person => !person.removed || draft.payerIds.includes(person.id)).length === 1} disabled={disabled}>
      <PayerFields participants={group.participants} draft={draft} disabled={disabled || !!group.archived} preserveRemoved={!!acceptedExpense}
        label={label} onChange={change} status={payerStatus} onToggle={togglePayer} onAdjust={adjustPayer} />
    </BillPeople>
    <BillPeople total={formattedTotal} count={draft.participantIds.length} icon="people" title="Split between" summary={between} inline={group.participants.filter(person => !person.removed || draft.participantIds.includes(person.id)).length === 1} disabled={disabled}>
      <SplitFields participants={group.participants} draft={draft} disabled={disabled} preserveRemoved={!!acceptedExpense}
        label={label} onChange={change} status={splitStatus} />
    </BillPeople>
    <DateField label="Date" value={draft.date} onChange={date => change({ date })} disabled={disabled} />
    <TextField autoCorrect={false} label="Notes (optional)" value={draft.notes} onChangeText={notes => change({ notes })} multiline style={styles.notes} maxLength={2000} editable={!disabled} />
    {!expense && <DraftAttachment value={draft.attachment} path={`/groups/${group.id}/expenses/${draft.id}/attachments`} disabled={disabled || !!group.archived} onChange={async attachment => { await change({ attachment }); }} onBusy={setFileBusy} onError={setError} />}
    {!!error && <ErrorText live>{error}</ErrorText>}
    <Button title={saving ? 'Saving…' : 'Save bill'} onPress={() => void save()} disabled={disabled || group.archived} kind="primary" icon="check" />
  </Form>;
}

const styles = StyleSheet.create({
  form: { gap: 12 }, field: { gap: 7 },
  personRow: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  methods: { flexDirection: 'row', borderWidth: 1, borderRadius: 12, overflow: 'hidden' },
  method: { flex: 1, minWidth: 0, minHeight: 64, paddingVertical: 8, paddingHorizontal: 2, alignItems: 'center', justifyContent: 'center', gap: 4 },
  selectionMark: { width: 24, height: 24, borderRadius: 12, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  notes: { minHeight: 100, textAlignVertical: 'top' }, reveal: { gap: 8, paddingBottom: 4 },
  adjustTouch: { minWidth: 44, minHeight: 44, justifyContent: 'center', borderRadius: 8, flexShrink: 1 },
  adjustChip: { borderRadius: 8, paddingHorizontal: 12, paddingVertical: 5 },
  adjustText: { fontSize: 14, lineHeight: 20, fontWeight: '700', fontVariant: ['tabular-nums'], textAlign: 'center' },
});
