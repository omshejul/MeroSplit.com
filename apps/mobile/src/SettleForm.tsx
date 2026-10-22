import React, { useRef, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { addSettlement, formatMoney, integer, rupeesToPaise } from './accounting';
import type { Group } from './types';

type Payment = { sender: string; recipient: string; amount: string };
type Props = { group: Group; initial?: Payment; busy: boolean; onSave: (payment: Payment) => Promise<void>; onCancel: () => void };
const rupees = (value: string) => { const amount = integer(value); return `${amount / 100n}.${(amount % 100n).toString().padStart(2, '0')}`; };

export default function SettleForm({ group, initial, busy, onSave, onCancel }: Props) {
  const proposal = initial ?? group.transfers[0];
  const [sender, setSender] = useState(proposal?.sender ?? group.participants[0]?.id ?? '');
  const [recipient, setRecipient] = useState(proposal?.recipient ?? group.participants.find(person => person.id !== sender)?.id ?? '');
  const [amount, setAmount] = useState(proposal ? rupees(proposal.amount) : ''), [error, setError] = useState(''), [saving, setSaving] = useState(false);
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
    if (disabled) return;
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
  return <View style={styles.form}>
    <Text style={styles.heading}>Record a payment</Text>
    <Text>Record money already paid outside SplitDumb. You can enter a partial amount.</Text>
    <Text style={styles.section}>From</Text>
    {group.participants.map(person => <Pressable key={`from-${person.id}`} accessibilityRole="radio" accessibilityLabel={`From ${label(person.id)}`}
      accessibilityState={{ checked: sender === person.id, disabled }} disabled={disabled} style={[styles.control, sender === person.id && styles.selected]}
      onPress={() => { setSender(person.id); if (recipient === person.id) setRecipient(group.participants.find(value => value.id !== person.id)?.id ?? ''); setError(''); }}>
      <Text>{sender === person.id ? '✓ ' : ''}{label(person.id)}</Text>
    </Pressable>)}
    <Text style={styles.section}>To</Text>
    {group.participants.filter(person => person.id !== sender).map(person => <Pressable key={`to-${person.id}`} accessibilityRole="radio" accessibilityLabel={`To ${label(person.id)}`}
      accessibilityState={{ checked: recipient === person.id, disabled }} disabled={disabled} style={[styles.control, recipient === person.id && styles.selected]}
      onPress={() => { setRecipient(person.id); setError(''); }}><Text>{recipient === person.id ? '✓ ' : ''}{label(person.id)}</Text></Pressable>)}
    <View style={styles.field}><Text>Amount paid (₹)</Text><TextInput accessibilityLabel="Amount paid (₹)" keyboardType="decimal-pad" value={amount}
      onChangeText={value => { setAmount(value); setError(''); }} editable={!disabled} style={styles.input} /></View>
    {profile && <><Text selectable>{label(recipient)}'s UPI ID: {profile.vpa}</Text><Text>This address was added by the person and has not been bank verified.</Text></>}
    {!!error && <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={styles.error}>{error}</Text>}
    <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={confirm} style={[styles.control, styles.primary]}><Text style={styles.primaryText}>{saving ? 'Recording…' : 'Record payment'}</Text></Pressable>
    <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onCancel} style={styles.control}><Text>Cancel</Text></Pressable>
  </View>;
}

const styles = StyleSheet.create({
  form: { gap: 12 }, field: { gap: 6 }, heading: { fontSize: 22, fontWeight: '600' }, section: { fontSize: 17, fontWeight: '600', marginTop: 8 },
  input: { minHeight: 44, borderWidth: 1, borderColor: '#888', padding: 10, color: '#111', fontSize: 16 },
  control: { minHeight: 44, borderWidth: 1, borderColor: '#888', padding: 12, justifyContent: 'center' }, selected: { backgroundColor: '#eee' },
  primary: { backgroundColor: '#111' }, primaryText: { color: 'white', fontWeight: '600', textAlign: 'center' }, error: { color: '#a11919' },
});
