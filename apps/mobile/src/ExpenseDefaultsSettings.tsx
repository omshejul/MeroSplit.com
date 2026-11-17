import React, { useEffect, useRef, useState } from 'react';
import { View, useWindowDimensions } from 'react-native';
import { Text } from 'react-native-paper';
import type { Group } from './types';
import { Button, ErrorText, SectionHeading, SettingsRow, useUI } from './ui';
import KeyboardDialog from './KeyboardDialog';
import { Dialog, DialogScrollBody } from './DialogParts';
import PersonChoice from './PersonChoice';
import { SplitFields, startingDraft } from './ExpenseForm';
import { defaultExpenseChoices, readExpenseDefaults, saveExpenseDefaults } from './expenseDefaults';
import type { ExpenseDefaults } from './expenseDefaults';
import { getDatabase } from './native';
import { useToast } from './Toast';

function DefaultsEditor({ group, selfId, owner, onClose }: { group: Group; selfId: string; owner: string; onClose: () => void }) {
  const { ui } = useUI(), toast = useToast(), { fontScale } = useWindowDimensions();
  const [choices, setChoices] = useState<ExpenseDefaults | null>(null), [error, setError] = useState(''), [saving, setSaving] = useState(false);
  const [template] = useState(() => startingDraft(group, undefined, selfId));
  const lock = useRef(false), mounted = useRef(true);
  async function load() {
    setError('');
    try {
      const saved = await readExpenseDefaults(await getDatabase(), owner, group.id);
      if (mounted.current) setChoices(defaultExpenseChoices(group, selfId, saved));
    } catch { if (mounted.current) setError('Could not load default settings. Try again.'); }
  }
  useEffect(() => { mounted.current = true; void load(); return () => { mounted.current = false; }; }, []);
  const active = group.participants.filter(person => !person.removed);
  const label = (id: string) => {
    const person = group.participants.find(person => person.id === id);
    const duplicates = active.filter(value => value.name === person?.name);
    return `${person?.name ?? 'Unknown person'}${duplicates.length > 1 ? ` (${duplicates.findIndex(value => value.id === id) + 1})` : ''}${id === selfId && person?.name.toLowerCase() !== 'you' ? ' (you)' : ''}`;
  };
  async function save(reset = false) {
    if (lock.current || !choices) return;
    lock.current = true; setSaving(true); setError('');
    try {
      if (!reset && (!choices.payerIds.length || !choices.participantIds.length)) throw new Error('Choose at least one payer and one person to share the bill.');
      await saveExpenseDefaults(await getDatabase(), owner, group.id, reset ? null : defaultExpenseChoices(group, selfId, choices));
      if (mounted.current) { toast(reset ? 'Defaults reset.' : 'Defaults saved.'); onClose(); }
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : 'Could not save default settings. Try again.'); }
    finally { lock.current = false; if (mounted.current) setSaving(false); }
  }
  return <KeyboardDialog visible dismissable={!saving} onDismiss={() => { if (!saving) onClose(); }}>
    <Dialog.Title icon="settings">Bill defaults</Dialog.Title>
    <DialogScrollBody maxHeight={560} gap={12}>
      <Text style={ui.caption}>Saved on this device for new bills. Existing bills and drafts stay as they are.</Text>
      {choices ? <>
        <SectionHeading>Who paid?</SectionHeading>
        {active.map(person => <PersonChoice key={person.id} person={person} title={label(person.id)} selected={choices.payerIds.includes(person.id)} disabled={saving}
          onPress={() => { setError(''); setChoices({ ...choices, payerIds: choices.payerIds.includes(person.id) ? choices.payerIds.filter(id => id !== person.id) : [...choices.payerIds, person.id] }); }} />)}
        {choices.payerIds.length > 1 && <Text style={ui.caption}>The amount starts equally divided between payers. You can change it on each bill.</Text>}
        <SectionHeading>Split between</SectionHeading>
        <SplitFields wrapMethods participants={active} draft={{ ...template, ...choices }} disabled={saving} preserveRemoved={false} label={label} status=""
          onChange={patch => { setError(''); setChoices({ ...choices, ...patch, ...(patch.participantIds ? { allParticipants: active.every(person => patch.participantIds!.includes(person.id)) } : {}) }); }} />
        {choices.mode === 'exact' && <Text style={ui.caption}>Exact amounts must add up to each new bill's total.</Text>}
        <Button title="Reset defaults" icon="refresh" kind="text" disabled={saving} onPress={() => void save(true)} />
      </> : !error ? <Text style={ui.caption}>Loading defaults…</Text> : <Button title="Try again" onPress={() => void load()} />}
      {!!error && <ErrorText live>{error}</ErrorText>}
    </DialogScrollBody>
    <Dialog.Actions style={fontScale > 1.3 ? { flexDirection: 'column', alignItems: 'stretch' } : undefined}>
      <Button title="Cancel" kind="text" icon="close" disabled={saving} onPress={onClose} />
      <Button title={saving ? 'Saving…' : 'Save defaults'} kind="primary" disabled={saving || !choices} onPress={() => void save()} />
    </Dialog.Actions>
  </KeyboardDialog>;
}
export default function ExpenseDefaultsSettings({ group, selfId, owner, busy }: { group: Group; selfId: string; owner: string; busy: boolean }) {
  const [open, setOpen] = useState(false);
  return <View>
    <SettingsRow icon="settings" label="Default settings" disabled={busy} onPress={() => setOpen(true)} />
    {open && <DefaultsEditor group={group} selfId={selfId} owner={owner} onClose={() => setOpen(false)} />}
  </View>;
}
