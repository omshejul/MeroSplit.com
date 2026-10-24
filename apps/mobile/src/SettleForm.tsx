import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Linking, Platform, Pressable, StyleSheet, View } from 'react-native';
import { Text } from 'react-native-paper';
import { Alert } from './alerts';
import { isPersonalPayment } from './personalBalances';
import { addSettlement, formatMoney, integer, rupeesToPaise } from './accounting';
import type { Group } from './types';
import { Button, ErrorText, Icon, useUI } from './ui';
import type { Palette } from './ui';
import { AmountField, RadioChoice } from './FormFields';
import LoadingSpinner from './LoadingSpinner';
import { PaymentAddress, PaymentHelpDialog, UPIAppChooser, WebPaymentQuote } from './PaymentPanels';
import { copyText } from './clipboard';
import UPIAppDirectory from './UPIAppDirectory';
import { availableUPIApps, buildUPIUrl, openUPIPayment, validateUPIPayment } from './upi';
import type { UPIApp, UPILaunchQuote } from './upi';
import { openAndroidUPIChooser } from './upiHandoff';
import { launchPaymentReturn, paymentReturnEvent, paymentReturnNeedsConfirmation, PaymentReturnReviewError } from './paymentReturn';
import type { PaymentReturn, PaymentReturnEvent } from './paymentReturn';

type Payment = { sender: string; recipient: string; amount: string };
type Props = { group: Group; initial?: Payment; busy: boolean; onSave: (payment: Payment) => Promise<void>; onCancel: () => void;
  selfId: string; onReviewAttempt: (sender: string, recipient: string) => Promise<void>; onPrepareUPI: (payment: Payment) => Promise<UPILaunchQuote>; onCancelUPI: (attemptId: string) => Promise<void>;
  returnPayment: PaymentReturn | null; onArmReturn: (payment: Payment, quote: UPILaunchQuote) => Promise<PaymentReturn>;
  onReturnPaymentChange: (next: PaymentReturn | null) => Promise<void>; onResolveReturn: (record: PaymentReturn, paid: boolean) => Promise<void> };
const rupees = (value: string) => { const amount = integer(value); return `${amount / 100n}.${(amount % 100n).toString().padStart(2, '0')}`; };

function PaymentPersonChoices({ people, selected, label, direction, disabled, onSelect }: {
  people: Group['participants']; selected: string; label: (id: string) => string;
  direction: 'From' | 'To'; disabled: boolean; onSelect: (id: string) => void;
}) {
  const { ui } = useUI();
  return <>
    <Text style={ui.label}>{direction}</Text>
    {people.map(person => <RadioChoice key={person.id} value={person.id} label={label(person.id)} accessibilityLabel={`${direction} ${label(person.id)}`}
      selected={selected === person.id} disabled={disabled} onPress={() => onSelect(person.id)} />)}
  </>;
}

export default function SettleForm({ group, initial, busy, selfId, onSave, onReviewAttempt, onPrepareUPI, onCancelUPI, onCancel, returnPayment, onArmReturn, onReturnPaymentChange, onResolveReturn }: Props) {
  const { palette: colors, ui } = useUI();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const proposal = initial && isPersonalPayment(group, selfId, initial.sender, initial.recipient) ? initial : undefined;
  const [sender, setSender] = useState(proposal?.sender ?? selfId);
  const [recipient, setRecipient] = useState(proposal?.recipient ?? '');
  const [amount, setAmount] = useState(proposal ? rupees(proposal.amount) : ''), [error, setError] = useState(''), [saving, setSaving] = useState(false);
  const [peopleOpen, setPeopleOpen] = useState(!proposal);
  const [failureHelp, setFailureHelp] = useState(false);
  const [notice, setNotice] = useState(''), [reviewing, setReviewing] = useState(false);
  const [chooser, setChooser] = useState<{ payment: Payment; target: { vpa: string; name: string }; apps: UPIApp[] } | null>(null);
  const [webQuote, setWebQuote] = useState<{ quote: UPILaunchQuote; url: string; target: { vpa: string; name: string } } | null>(null);
  const [returnRecord, setReturnRecord] = useState(returnPayment), [returnError, setReturnError] = useState(''), [returnReview, setReturnReview] = useState(false);
  const returnRef = useRef(returnPayment), returnWrites = useRef(Promise.resolve());
  const armedHere = useRef<string | null>(null);
  const returnChange = useRef(onReturnPaymentChange); returnChange.current = onReturnPaymentChange;
  const lock = useRef(false), mounted = useRef(true), disabled = busy || saving || reviewing || !!chooser;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!returnPayment || returnPayment.attemptId !== returnRef.current?.attemptId) {
      returnRef.current = returnPayment; setReturnRecord(returnPayment); setReturnError(''); setReturnReview(false);
    }
  }, [returnPayment]);
  function persistReturn(next: PaymentReturn) {
    returnRef.current = next;
    if (mounted.current) setReturnRecord(next);
    const write = returnWrites.current.catch(() => {}).then(() => returnChange.current(next));
    returnWrites.current = write;
    return write;
  }
  function transitionReturn(event: PaymentReturnEvent): Promise<void> {
    const current = returnRef.current;
    if (!current) return Promise.resolve();
    const next = paymentReturnEvent(current, event);
    return next === current ? Promise.resolve() : persistReturn(next);
  }
  useEffect(() => {
    const changed = (state: string) => {
      if (state !== 'active' && state !== 'background') return;
      void transitionReturn({ type: state }).catch(() => {
        if (mounted.current) setReturnError('Could not save this payment reminder. Try again.');
      });
    };
    // Restore an observed departure after process death; an unrelated launch has no leftApp flag.
    if (Platform.OS !== 'web' && returnRef.current?.launch === 'opening' && armedHere.current !== returnRef.current.attemptId) {
      void transitionReturn({ type: 'failed' }).catch(() => {});
    } else if (AppState.currentState === 'active') changed('active');
    const subscription = AppState.addEventListener('change', changed);
    if (Platform.OS === 'web' && typeof document !== 'undefined') {
      const visibility = () => changed(document.visibilityState === 'hidden' ? 'background' : 'active');
      document.addEventListener('visibilitychange', visibility);
      return () => { subscription.remove(); document.removeEventListener('visibilitychange', visibility); };
    }
    return () => subscription.remove();
  }, [returnPayment?.attemptId]);
  async function armReturn(payment: Payment, quote: UPILaunchQuote) {
    const record = await onArmReturn(payment, quote);
    if (!mounted.current) throw new Error('Open this payment again before continuing.');
    if (record.groupId !== group.id || record.groupVersion !== quote.group_version || record.attemptId !== quote.id || record.sender !== payment.sender || record.recipient !== payment.recipient || record.amount !== payment.amount || record.payeeName !== quote.recipient || record.vpa !== quote.vpa) throw new Error('Payment details changed. Review them again.');
    if (record.decision !== null) throw new Error('Confirm the saved update before opening UPI again.');
    armedHere.current = record.attemptId;
    returnRef.current = record; setReturnRecord(record); setReturnError(''); setReturnReview(false);
  }
  async function resolveReturn(paid: boolean) {
    if (lock.current || busy || !returnRef.current || !paymentReturnNeedsConfirmation(returnRef.current)) return;
    lock.current = true; setSaving(true); setReturnError('');
    try {
      await transitionReturn({ type: 'decision', paid });
      const frozen = returnRef.current!;
      await returnWrites.current;
      await onResolveReturn(frozen, frozen.decision === 'paid');
    } catch (cause) {
      if (mounted.current) {
        setReturnReview(cause instanceof PaymentReturnReviewError);
        setReturnError(cause instanceof PaymentReturnReviewError ? cause.message : 'Could not confirm the update. Try again.');
      }
    } finally { lock.current = false; if (mounted.current) setSaving(false); }
  }

  useEffect(() => {
    if (!isPersonalPayment(group, selfId, sender, recipient)) return;
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
    try {
      if (!isPersonalPayment(group, selfId, payment.sender, payment.recipient)) throw new Error('Choose a payment to or from you.');
      await onSave(payment);
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not record the payment. Try again.'); }
    finally { lock.current = false; setSaving(false); }
  }
  async function handoff(payment: Payment, target: { vpa: string; name: string }, app?: UPIApp) {
    const quote = await onPrepareUPI(payment);
    if (!mounted.current) return;
    if (quote.amount !== payment.amount || quote.vpa !== target.vpa || quote.recipient !== target.name) throw new Error('The amount or recipient changed. Review the payment again.');
    const url = buildUPIUrl(quote);
    if (Platform.OS === 'web') {
      setPeopleOpen(false);
      await armReturn(payment, quote); await transitionReturn({ type: 'opening' });
      if (mounted.current) setWebQuote({ quote, url, target });
      return;
    }
    await launchPaymentReturn(() => armReturn(payment, quote), transitionReturn,
      () => { if (!mounted.current) throw new Error('Open this payment again before continuing.'); return openUPIPayment(quote, app!.id, { amount: payment.amount, ...target }, url => Platform.OS === 'android' ? openAndroidUPIChooser(url) : Linking.openURL(url)); },
      Platform.OS === 'android' || Platform.OS === 'ios' && app!.id !== 'upi');
  }
  function openWebPayment() {
    if (!webQuote || lock.current || busy) return;
    const selected = webQuote, frozen = returnRef.current;
    if (!frozen || frozen.attemptId !== selected.quote.id || frozen.amount !== selected.quote.amount || frozen.vpa !== selected.quote.vpa || frozen.payeeName !== selected.quote.recipient || frozen.launch !== 'opening' || frozen.decision !== null) {
      setError('Review the payment again before opening UPI.'); return;
    }
    lock.current = true; setSaving(true); setError('');
    // armReturn/opening were persisted before rendering this button. The opener
    // runs synchronously in this click, before any IndexedDB/promise continuation.
    const opened = openUPIPayment(selected.quote, 'upi', { amount: frozen.amount, name: frozen.payeeName, vpa: frozen.vpa }, url => Linking.openURL(url));
    void opened.then(() => transitionReturn({ type: 'opened', handoffConfirmed: false })).catch(async cause => {
      await transitionReturn({ type: 'failed' }).catch(() => {});
      if (mounted.current) { setWebQuote(null); setError(cause instanceof Error ? cause.message : 'Could not open UPI.'); }
    }).finally(() => { lock.current = false; if (mounted.current) setSaving(false); });
  }
  async function reviewWebPayment() {
    if (!webQuote || lock.current || busy) return;
    lock.current = true; setSaving(true); setError('');
    try { await transitionReturn({ type: 'review' }); }
    catch { if (mounted.current) setError('Could not save this payment reminder. Try again.'); }
    finally { lock.current = false; if (mounted.current) setSaving(false); }
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
    try { await onCancelUPI(id); if (mounted.current) { setWebQuote(null); setNotice('Unpaid attempt cancelled.'); } }
    catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : 'Could not cancel this attempt.'); }
    finally { lock.current = false; if (mounted.current) setSaving(false); }
  }
  async function copy(text: string) {
    try { await copyText(text); setNotice('Copied.'); }
    catch { setError('Select the payment details below and copy them.'); }
  }
  function confirm() {
    if (disabled || group.archived) return;
    try {
      if (!isPersonalPayment(group, selfId, sender, recipient)) throw new Error('Choose a payment to or from you.');
      const payment = { sender, recipient, amount: rupeesToPaise(amount) };
      addSettlement(group.balances, sender, recipient, payment.amount);
      setError('');
      Alert.alert('Record this payment?', `${label(sender)} paid ${label(recipient)} ${formatMoney(payment.amount)}.`, [
        { text: 'Cancel', style: 'cancel' }, { text: 'Record payment', onPress: () => void save(payment) },
      ]);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Check the people and payment amount.'); }
  }
  const profile = group.participants.find(person => person.id === recipient)?.payment_profile;
  const otherPerson = group.participants.find(person => person.id !== selfId && person.id === (sender === selfId ? recipient : sender));
  const debt = group.transfers.find(value => value.sender === sender && value.recipient === recipient);
  const activeAttempt = group.payment_attempts?.find(value => value.sender === sender && value.recipient === recipient && ['prepared', 'reported'].includes(value.state));
  const canPay = sender === selfId && !!debt && !!profile && !group.archived && activeAttempt?.state !== 'reported';
  let amountLabel = '';
  try { amountLabel = formatMoney(rupeesToPaise(amount)); } catch { /* Validate on confirmation, without interrupting typing. */ }
  const pendingReturn = returnRecord && returnRecord.groupId === group.id && returnRecord.sender === selfId && (returnRecord.launch === 'opened' || returnRecord.launch === 'opening' && (Platform.OS !== 'web' || !webQuote && !saving) || paymentReturnNeedsConfirmation(returnRecord)) ? returnRecord : null;
  if (pendingReturn) {
    const needsAnswer = paymentReturnNeedsConfirmation(pendingReturn);
    return <View style={styles.form}>
      <Text style={ui.caption}>{group.name}</Text>
      <Text style={[ui.section, styles.returnTitle]}>{needsAnswer ? `Did you pay ${pendingReturn.payeeName} ${formatMoney(pendingReturn.amount)}?` : `${formatMoney(pendingReturn.amount)} to ${pendingReturn.payeeName}`}</Text>
      <PaymentAddress name={pendingReturn.payeeName} vpa={pendingReturn.vpa} />
      <LoadingSpinner visible={busy || saving || reviewing} />
      {!!returnError && <ErrorText>{returnError}</ErrorText>}
      {returnReview ? <Button title="Review balance" kind="primary" onPress={onCancel} disabled={disabled} /> : pendingReturn.decision !== null ?
        <Button title={saving ? 'Confirming update…' : 'Try again'} kind="primary" onPress={() => void resolveReturn(pendingReturn.decision === 'paid')} disabled={disabled} /> : needsAnswer ? <>
          <Button title={saving ? 'Recording payment…' : 'Yes, I paid'} kind="primary" onPress={() => void resolveReturn(true)} disabled={disabled} />
          <Button title="No" kind="secondary" onPress={() => void resolveReturn(false)} disabled={disabled} />
          <Button title="Payment failed" kind="text" onPress={() => setFailureHelp(true)} disabled={disabled} />
        </> : <Button title="Review payment" kind="primary" disabled={disabled || pendingReturn.launch === 'opening' && Platform.OS !== 'web'} onPress={() => void transitionReturn({ type: 'review' }).catch(() => setReturnError('Could not save this payment reminder. Try again.'))} />}
      <PaymentHelpDialog visible={failureHelp} name={pendingReturn.payeeName} vpa={pendingReturn.vpa} onClose={() => setFailureHelp(false)} />
    </View>;
  }
  return <View style={styles.form}>
    <Text style={ui.caption}>{group.name}</Text>
    {!webQuote && <View style={styles.field}><Text style={ui.rowTitle}>From {label(sender)}</Text><Text style={ui.rowTitle}>To {label(recipient)}</Text></View>}
    <LoadingSpinner visible={busy || saving || reviewing} />
    {group.archived && <Text style={ui.notice}>Reopen this group in settings before recording a payment.</Text>}
    {!webQuote && <><AmountField label="Amount (₹)" value={amount}
      onChangeText={value => { setAmount(value); setError(''); setWebQuote(null); }} editable={!disabled && !webQuote} placeholder="0" />
    <View style={styles.people}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: peopleOpen, disabled: disabled || !!webQuote }} disabled={disabled || !!webQuote} onPress={() => setPeopleOpen(value => !value)} style={styles.summary}>
        <Text style={ui.rowTitle}>Change people</Text><View style={{ transform: [{ rotate: peopleOpen ? '180deg' : '0deg' }] }}><Icon name="down" size={20} /></View>
      </Pressable>
      {peopleOpen && <View style={styles.reveal}>
        <PaymentPersonChoices direction="From" people={group.participants.filter(person => !person.removed)} selected={sender} label={label} disabled={disabled}
          onSelect={id => { setSender(id); if (id !== selfId) setRecipient(selfId); else if (recipient === selfId) setRecipient(''); setError(''); setWebQuote(null); }} />
        <PaymentPersonChoices direction="To" people={group.participants.filter(person => person.id !== sender && !person.removed && (sender === selfId || person.id === selfId))} selected={recipient} label={label} disabled={disabled}
          onSelect={id => { setRecipient(id); setError(''); setWebQuote(null); }} />
      </View>}
    </View>
    </>}
    {otherPerson?.payment_profile && !webQuote && <PaymentAddress name={label(otherPerson.id)} vpa={otherPerson.payment_profile.vpa} />}
    {sender === selfId && debt && !profile && <Text style={ui.caption}>Ask {label(recipient)} to {group.participants.find(person => person.id === recipient)?.user_id != null ? 'add a UPI address' : 'join and add a UPI address'}.</Text>}
    {canPay && !webQuote && <><Text style={ui.caption}>Pay up to {formatMoney(debt!.amount)}.</Text><Button title={saving ? 'Preparing…' : amountLabel ? `Pay ${amountLabel} with UPI` : 'Pay with UPI'} kind="primary" icon="pay" disabled={disabled || !amountLabel} onPress={() => void pay()} /></>}
    {canPay && !webQuote && <UPIAppDirectory disabled={disabled} />}
    {webQuote && <WebPaymentQuote quote={webQuote.quote} url={webQuote.url} disabled={disabled}
      onCopy={text => void copy(text)} onOpen={openWebPayment} onReview={() => void reviewWebPayment()} />}
    {activeAttempt?.state === 'reported' && sender === selfId && <Text style={ui.caption}>This payment is already reported. Check it before paying again.</Text>}
    {activeAttempt?.state === 'prepared' && sender === selfId && <Button title="Cancel unpaid attempt" kind="text" disabled={disabled} onPress={() => Alert.alert('Cancel unpaid attempt?', 'Cancel this unpaid attempt?', [{ text: 'Keep', style: 'cancel' }, { text: 'Cancel attempt', onPress: () => void cancelAttempt(activeAttempt.id) }])} />}
    {!!notice && <Text accessibilityLiveRegion="polite" style={ui.caption}>{notice}</Text>}
    {!!error && <ErrorText live>{error}</ErrorText>}
    {!webQuote && <Button title={amountLabel ? `Record ${amountLabel} already paid` : 'Record a payment already made'} accessibilityLabel={amountLabel ? `Record ${amountLabel} to ${label(recipient)}` : 'Record payment'} onPress={confirm} disabled={disabled || group.archived || !isPersonalPayment(group, selfId, sender, recipient)} kind={canPay ? 'secondary' : 'primary'} icon="check" />}
    <UPIAppChooser apps={chooser?.apps ?? null} recipient={chooser?.target ?? null} disabled={busy || saving} onChoose={app => void pay(app)} onDismiss={() => { if (!busy && !saving) setChooser(null); }} />
  </View>;
}

const makeStyles = (colors: Palette) => StyleSheet.create({
  returnTitle: { fontSize: 24, lineHeight: 31 },
  form: { gap: 12 }, field: { gap: 7 },
  people: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  summary: { minHeight: 52, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12 }, reveal: { gap: 12, paddingBottom: 12 },
});
