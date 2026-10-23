import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Linking, Platform, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { Dialog, Portal, RadioButton, Text } from 'react-native-paper';
import QRCode from 'react-native-qrcode-svg';
import { Alert } from './alerts';
import { addSettlement, formatMoney, integer, rupeesToPaise } from './accounting';
import type { Group } from './types';
import { Button, Disclosure, Icon, useUI } from './ui';
import type { Palette } from './ui';
import { availableUPIApps, buildUPIUrl, openUPIPayment, validateUPIPayment } from './upi';
import type { UPIApp, UPILaunchQuote } from './upi';

type Payment = { sender: string; recipient: string; amount: string };
type Props = { group: Group; initial?: Payment; busy: boolean; onSave: (payment: Payment) => Promise<void>; onCancel: () => void;
  selfId: string; onReviewAttempt: (sender: string, recipient: string) => Promise<void>; onPrepareUPI: (payment: Payment) => Promise<UPILaunchQuote>; onCancelUPI: (attemptId: string) => Promise<void> };
const rupees = (value: string) => { const amount = integer(value); return `${amount / 100n}.${(amount % 100n).toString().padStart(2, '0')}`; };

export default function SettleForm({ group, initial, busy, selfId, onSave, onReviewAttempt, onPrepareUPI, onCancelUPI }: Props) {
  const { palette: colors, ui, inputColors } = useUI();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const proposal = initial;
  const [sender, setSender] = useState(proposal?.sender ?? '');
  const [recipient, setRecipient] = useState(proposal?.recipient ?? '');
  const [amount, setAmount] = useState(proposal ? rupees(proposal.amount) : ''), [error, setError] = useState(''), [saving, setSaving] = useState(false);
  const [peopleOpen, setPeopleOpen] = useState(!initial);
  const [notice, setNotice] = useState(''), [reviewing, setReviewing] = useState(false);
  const [chooser, setChooser] = useState<{ payment: Payment; target: { vpa: string; name: string }; apps: UPIApp[] } | null>(null);
  const [webQuote, setWebQuote] = useState<{ quote: UPILaunchQuote; url: string; target: { vpa: string; name: string } } | null>(null);
  const lock = useRef(false), mounted = useRef(true), disabled = busy || saving || reviewing || !!chooser;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!sender || !recipient) return;
    let current = true; setReviewing(true);
    void onReviewAttempt(sender, recipient).catch(cause => { if (current) setError(cause instanceof Error ? cause.message : 'Could not review this payment.'); }).finally(() => { if (current) setReviewing(false); });
    return () => { current = false; };
  }, [sender, recipient]);
  useEffect(() => {
    if (!webQuote) return;
    const remaining = Date.parse(webQuote.quote.expires_at) - Date.now();
    if (remaining <= 0 || group.version > webQuote.quote.group_version) { setWebQuote(null); setNotice('Payment details changed or expired. Review again before paying.'); return; }
    const timer = setTimeout(() => { setWebQuote(null); setNotice('Payment details expired. Review again if you have not paid.'); }, remaining);
    return () => clearTimeout(timer);
  }, [webQuote, group.version]);
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
  async function handoff(payment: Payment, target: { vpa: string; name: string }, app?: UPIApp) {
    const quote = await onPrepareUPI(payment);
    if (!mounted.current) return;
    if (quote.amount !== payment.amount || quote.vpa !== target.vpa || quote.recipient !== target.name) throw new Error('The amount or recipient changed. Review the payment again.');
    const url = buildUPIUrl(quote);
    if (Platform.OS === 'web') { setWebQuote({ quote, url, target }); return; }
    await openUPIPayment(quote, app!.id, { amount: payment.amount, ...target }, url => Linking.openURL(url));
    if (mounted.current) setNotice('Check your UPI app. Record only the money you actually paid.');
  }
  async function pay(app?: UPIApp) {
    if (lock.current || busy || group.archived) return;
    lock.current = true; setSaving(true); setError(''); setNotice('');
    try {
      if (app && chooser) { const selected = chooser; setChooser(null); await handoff(selected.payment, selected.target, app); return; }
      const payment = { sender, recipient, amount: rupeesToPaise(amount) }, target = validateUPIPayment(group, selfId, payment);
      if (Platform.OS === 'web') { await handoff(payment, target); return; }
      const apps = await availableUPIApps(Platform.OS, url => Linking.canOpenURL(url));
      if (!mounted.current) return;
      if (!apps.length) throw new Error('No UPI app is available here. Use the payment address in your UPI app.');
      if (apps.length === 1) await handoff(payment, target, apps[0]);
      else setChooser({ payment, target, apps });
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : 'Could not open UPI. Use the payment address in your UPI app.'); }
    finally { lock.current = false; if (mounted.current) setSaving(false); }
  }
  async function cancelAttempt(id: string) {
    if (lock.current || busy) return;
    lock.current = true; setSaving(true); setError('');
    try { await onCancelUPI(id); if (mounted.current) { setWebQuote(null); setNotice('Unpaid attempt cancelled. No bank transfer was reversed.'); } }
    catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : 'Could not cancel this attempt.'); }
    finally { lock.current = false; if (mounted.current) setSaving(false); }
  }
  async function copy(text: string) {
    try { if (!navigator.clipboard) throw new Error('Clipboard unavailable'); await navigator.clipboard.writeText(text); setNotice('Copied.'); }
    catch { setError('Select the payment details below and copy them.'); }
  }
  function confirm() {
    if (disabled || group.archived) return;
    try {
      if (![sender, recipient].every(id => group.participants.some(person => person.id === id && !person.removed))) throw new Error('Choose active people for this payment.');
      const payment = { sender, recipient, amount: rupeesToPaise(amount) };
      addSettlement(group.balances, sender, recipient, payment.amount);
      setError('');
      Alert.alert('Record this payment?', `${label(sender)} paid ${label(recipient)} ${formatMoney(payment.amount)} outside MeroSplit. No money is sent.`, [
        { text: 'Cancel', style: 'cancel' }, { text: 'Record payment', onPress: () => void save(payment) },
      ]);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Check the people and payment amount.'); }
  }
  const profile = group.participants.find(person => person.id === recipient)?.payment_profile;
  const debt = group.transfers.find(value => value.sender === sender && value.recipient === recipient);
  const activeAttempt = group.payment_attempts?.find(value => value.sender === sender && value.recipient === recipient && ['prepared', 'reported'].includes(value.state));
  const canPay = sender === selfId && !!debt && !!profile && !group.archived && activeAttempt?.state !== 'reported';
  let amountLabel = '';
  try { amountLabel = formatMoney(rupeesToPaise(amount)); } catch { /* Validate on confirmation, without interrupting typing. */ }
  return <View style={styles.form}>
    <Text style={ui.caption}>{group.name}</Text>
    <View style={styles.field}><Text style={ui.rowTitle}>From {label(sender)}</Text><Text style={ui.rowTitle}>To {label(recipient)}</Text></View>
    {group.archived && <Text style={ui.notice}>Reopen this group in settings before recording a payment.</Text>}
    <View style={styles.field}><Text style={ui.label}>Amount (₹)</Text><TextInput {...inputColors} accessibilityLabel="Amount (₹)" keyboardType="decimal-pad" value={amount}
      onChangeText={value => { setAmount(value); setError(''); setWebQuote(null); }} editable={!disabled} placeholder="0" placeholderTextColor={colors.muted} style={[ui.input, styles.amount]} />
    </View>
    <View style={styles.people}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: peopleOpen, disabled }} disabled={disabled} onPress={() => setPeopleOpen(value => !value)} style={styles.summary}>
        <Text style={ui.rowTitle}>Change people</Text><View style={{ transform: [{ rotate: peopleOpen ? '180deg' : '0deg' }] }}><Icon name="down" size={20} /></View>
      </Pressable>
      {peopleOpen && <View style={styles.reveal}>
        <Text style={ui.label}>From</Text>
        {group.participants.filter(person => !person.removed).map(person => <RadioButton.Item key={`from-${person.id}`} value={person.id} label={label(person.id)} accessibilityLabel={`From ${label(person.id)}`}
          status={sender === person.id ? 'checked' : 'unchecked'} disabled={disabled} labelStyle={ui.body} mode="android"
          onPress={() => { setSender(person.id); if (recipient === person.id) setRecipient(group.participants.find(value => value.id !== person.id && !value.removed)?.id ?? ''); setError(''); setWebQuote(null); }} />)}
        <Text style={ui.label}>To</Text>
        {group.participants.filter(person => person.id !== sender && !person.removed).map(person => <RadioButton.Item key={`to-${person.id}`} value={person.id} label={label(person.id)} accessibilityLabel={`To ${label(person.id)}`}
          status={recipient === person.id ? 'checked' : 'unchecked'} disabled={disabled} labelStyle={ui.body} mode="android"
          onPress={() => { setRecipient(person.id); setError(''); setWebQuote(null); }} />)}
        <Button title="Done" onPress={() => setPeopleOpen(false)} disabled={disabled} kind="text" icon="check" />
      </View>}
    </View>
    {profile && <Disclosure title="Payment address"><Text selectable style={ui.body}>{label(recipient)}'s UPI ID: {profile.vpa}</Text>
      <Text style={ui.caption}>Entered by this person. Not bank verified.</Text></Disclosure>}
    {sender === selfId && debt && !profile && <Text style={ui.caption}>Ask {label(recipient)} to {group.participants.find(person => person.id === recipient)?.user_id != null ? 'add a UPI address' : 'join and add a UPI address'}. You can still record a payment made outside MeroSplit.</Text>}
    {canPay && <><Text style={ui.caption}>Pay up to {formatMoney(debt!.amount)}. Check the recipient in your UPI app.</Text><Button title={saving ? 'Preparing…' : amountLabel ? `Pay ${amountLabel} with UPI` : 'Pay with UPI'} kind="primary" icon="pay" disabled={disabled || !amountLabel} onPress={() => void pay()} /></>}
    {webQuote && <View style={styles.field}>
      <Text style={ui.rowTitle}>{webQuote.quote.recipient} · {formatMoney(webQuote.quote.amount)}</Text>
      <View accessibilityRole="image" accessibilityLabel="Scan this UPI payment QR with your payment app" style={{ alignSelf: 'center', padding: 12, backgroundColor: '#FFFFFF' }}><QRCode value={webQuote.url} size={200} quietZone={12} /></View>
      <Text selectable style={ui.body}>{webQuote.quote.vpa}</Text>
      <Button title="Copy UPI address" kind="text" disabled={disabled} onPress={() => void copy(webQuote.quote.vpa)} />
      <Button title="Copy payment link" kind="text" disabled={disabled} onPress={() => void copy(webQuote.url)} />
      <Button title="Open UPI app on this device" disabled={disabled} onPress={() => void openUPIPayment(webQuote.quote, 'upi', { amount: webQuote.quote.amount, ...webQuote.target }, url => Linking.openURL(url)).catch(cause => setError(cause.message))} />
      <Text style={ui.caption}>Scan with your phone. Record only after you have paid.</Text>
    </View>}
    {activeAttempt?.state === 'reported' && sender === selfId && <Text style={ui.caption}>This payment is already reported. Check it before paying again.</Text>}
    {activeAttempt?.state === 'prepared' && sender === selfId && <Button title="Cancel unpaid attempt" kind="text" disabled={disabled} onPress={() => Alert.alert('Cancel unpaid attempt?', 'Cancel only if you have not paid. This cannot reverse money already sent.', [{ text: 'Keep', style: 'cancel' }, { text: 'Cancel attempt', onPress: () => void cancelAttempt(activeAttempt.id) }])} />}
    {!!notice && <Text accessibilityLiveRegion="polite" style={ui.caption}>{notice}</Text>}
    {!!error && <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={ui.error}>{error}</Text>}
    <Button title={amountLabel ? `Record ${amountLabel} already paid` : 'Record a payment already made'} accessibilityLabel={amountLabel ? `Record ${amountLabel} to ${label(recipient)}` : 'Record payment'} onPress={confirm} disabled={disabled || group.archived} kind={canPay ? 'secondary' : 'primary'} icon="check" />
    <Portal><Dialog visible={!!chooser} onDismiss={() => { if (!busy && !saving) setChooser(null); }}><Dialog.Title>Pay with UPI</Dialog.Title><Dialog.Content><Text style={ui.body}>Check the recipient and amount before paying.</Text></Dialog.Content><Dialog.ScrollArea style={{ maxHeight: 360 }}><ScrollView contentContainerStyle={{ paddingVertical: 8, gap: 8 }}>{chooser?.apps.map(app => <Button key={app.id} title={app.name} disabled={busy || saving} onPress={() => void pay(app)} />)}</ScrollView></Dialog.ScrollArea><Dialog.Actions><Button title="Cancel" kind="text" disabled={busy || saving} onPress={() => setChooser(null)} /></Dialog.Actions></Dialog></Portal>
  </View>;
}

const makeStyles = (colors: Palette) => StyleSheet.create({
  form: { gap: 12 }, field: { gap: 7 },
  amount: { fontSize: 32, minHeight: 64, fontWeight: '600', fontVariant: ['tabular-nums'] }, people: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  summary: { minHeight: 52, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12 }, reveal: { gap: 12, paddingBottom: 12 },
});
