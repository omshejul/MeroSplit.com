import React, { useMemo, useRef, useState } from 'react';
import { Alert, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { RadioButton, Text } from 'react-native-paper';
import { addSettlement, formatMoney, integer, rupeesToPaise } from './accounting';
import type { Group } from './types';
import { Avatar, Button, Disclosure, Icon, useUI } from './ui';
import type { Palette } from './ui';

type Payment = { sender: string; recipient: string; amount: string };
type Props = { group: Group; initial?: Payment; busy: boolean; onSave: (payment: Payment) => Promise<void>; onCancel: () => void };
const rupees = (value: string) => { const amount = integer(value); return `${amount / 100n}.${(amount % 100n).toString().padStart(2, '0')}`; };

export default function SettleForm({ group, initial, busy, onSave }: Props) {
  const { palette: colors, ui, inputColors } = useUI();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const proposal = initial ?? group.transfers[0];
  const [sender, setSender] = useState(proposal?.sender ?? group.participants[0]?.id ?? '');
  const [recipient, setRecipient] = useState(proposal?.recipient ?? group.participants.find(person => person.id !== sender)?.id ?? '');
  const [amount, setAmount] = useState(proposal ? rupees(proposal.amount) : ''), [error, setError] = useState(''), [saving, setSaving] = useState(false);
  const [peopleOpen, setPeopleOpen] = useState(false);
  const lock = useRef(false), disabled = busy || saving;
  const label = (id: string) => {
    const person = group.participants.find(value => value.id === id);
    if (!person) return 'Choose a person';
    const matching = group.participants.filter(value => value.name === person.name);
    return `${person.name}${matching.length > 1 ? ` (${matching.findIndex(value => value.id === id) + 1})` : ''}`;
  };
  async function save(payment: Payment) {
    if (lock.current || busy) return;
    lock.current = true; setSaving(true);
    try { await onSave(payment); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not record the payment. Try again.'); }
    finally { lock.current = false; setSaving(false); }
  }
  function confirm() {
    if (disabled || group.archived) return;
    try {
      const payment = { sender, recipient, amount: rupeesToPaise(amount) };
      addSettlement(group.balances, sender, recipient, payment.amount);
      setError('');
      Alert.alert('Record this payment?', `${label(sender)} paid ${label(recipient)} ${formatMoney(payment.amount)} outside the app. This records the payment and does not send money.`, [
        { text: 'Cancel', style: 'cancel' }, { text: 'Record payment', onPress: () => void save(payment) },
      ]);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Check the people and payment amount.'); }
  }
  const profile = group.participants.find(person => person.id === recipient)?.payment_profile;
  let amountLabel = '';
  try { amountLabel = formatMoney(rupeesToPaise(amount)); } catch { /* Validate on confirmation, without interrupting typing. */ }
  return <View style={styles.form}>
    <Text style={ui.caption}>{group.name}</Text>
    <View style={styles.person}><Avatar name={label(recipient)} /><View style={ui.rowBody}>
      <Text style={ui.label}>Paid to</Text><Text style={ui.section}>{label(recipient)}</Text><Text style={ui.caption}>From {label(sender)}</Text>
    </View></View>
    <Text style={ui.notice}>Record money already paid outside this app. This does not send money.</Text>
    {group.archived && <Text style={ui.notice}>Reopen this group in settings before recording a payment.</Text>}
    <View style={styles.field}><Text style={ui.label}>Amount paid (₹)</Text><TextInput {...inputColors} accessibilityLabel="Amount paid (₹)" keyboardType="decimal-pad" value={amount}
      onChangeText={value => { setAmount(value); setError(''); }} editable={!disabled} placeholder="0" placeholderTextColor={colors.muted} style={[ui.input, styles.amount]} />
      <Text style={ui.caption}>You can record part of the amount.</Text></View>
    <View style={styles.people}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: peopleOpen, disabled }} disabled={disabled} onPress={() => setPeopleOpen(value => !value)} style={styles.summary}>
        <Text style={ui.rowTitle}>Change people</Text><View style={{ transform: [{ rotate: peopleOpen ? '180deg' : '0deg' }] }}><Icon name="down" size={20} /></View>
      </Pressable>
      {peopleOpen && <View style={styles.reveal}>
        <Text style={ui.label}>From</Text>
        {group.participants.map(person => <RadioButton.Item key={`from-${person.id}`} value={person.id} label={label(person.id)} accessibilityLabel={`From ${label(person.id)}`}
          status={sender === person.id ? 'checked' : 'unchecked'} disabled={disabled} labelStyle={ui.body} mode="android"
          onPress={() => { setSender(person.id); if (recipient === person.id) setRecipient(group.participants.find(value => value.id !== person.id)?.id ?? ''); setError(''); }} />)}
        <Text style={ui.label}>To</Text>
        {group.participants.filter(person => person.id !== sender).map(person => <RadioButton.Item key={`to-${person.id}`} value={person.id} label={label(person.id)} accessibilityLabel={`To ${label(person.id)}`}
          status={recipient === person.id ? 'checked' : 'unchecked'} disabled={disabled} labelStyle={ui.body} mode="android"
          onPress={() => { setRecipient(person.id); setError(''); }} />)}
        <Button title="Done" onPress={() => setPeopleOpen(false)} disabled={disabled} kind="text" icon="check" />
      </View>}
    </View>
    {profile && <Disclosure title="Payment address"><Text selectable style={ui.body}>{label(recipient)}'s UPI ID: {profile.vpa}</Text>
      <Text style={ui.caption}>Entered by this person. Not bank verified.</Text></Disclosure>}
    {!!error && <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={ui.error}>{error}</Text>}
    <Button title={saving ? 'Recording…' : amountLabel ? `Record ${amountLabel}` : 'Record payment'} accessibilityLabel={amountLabel ? `Record ${amountLabel} to ${label(recipient)}` : 'Record payment'} onPress={confirm} disabled={disabled || group.archived} kind="primary" icon="check" />
  </View>;
}

const makeStyles = (colors: Palette) => StyleSheet.create({
  form: { gap: 12 }, field: { gap: 7 }, person: { flexDirection: 'row', gap: 14, alignItems: 'center', paddingVertical: 8 },
  amount: { fontSize: 32, minHeight: 64, fontWeight: '600', fontVariant: ['tabular-nums'] }, people: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  summary: { minHeight: 52, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12 }, reveal: { gap: 12, paddingBottom: 12 },
});
