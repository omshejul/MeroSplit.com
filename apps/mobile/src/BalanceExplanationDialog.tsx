import DetailDialog from './DetailDialog';
import { Dialog } from './DialogParts';
import React, { useEffect, useState } from 'react';
import { View, useWindowDimensions } from 'react-native';
import { Text } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { formatMoney, type Transfer } from './accounting';
import { balanceKey, changedBalance, explainTransfer } from './balanceExplanation';
import type { BalanceSource } from './balanceExplanationStorage';
import type { Command, Group } from './types';
import KeyboardDialog from './KeyboardDialog';
import { DialogScrollBody } from './DialogParts';
import { balanceColor, Button, SectionHeading, useUI } from './ui';

export type BalanceSelection = { group: Group; accepted: Group; commands: Command[]; selfId: string; transfer: Transfer; restoreFocus: () => void; load?: (expected: Group) => Promise<BalanceSource> };
type Explanation = ReturnType<typeof explainTransfer>;
const nameFor = (group: Group, selfId: string, id: string) => id === selfId ? 'You' : group.participants.find(person => person.id === id)?.name ?? 'Former member';
const netText = (name: string, amount: string) => BigInt(amount) > 0n ? `${name} ${name === 'You' ? 'are' : 'is'} owed ${formatMoney(amount)}` : BigInt(amount) < 0n ? `${name} ${name === 'You' ? 'owe' : 'owes'} ${formatMoney((-BigInt(amount)).toString())}` : `${name} ${name === 'You' ? 'are' : 'is'} settled up`;

function CalculationLine({ label, amount, subtract = false }: { label: string; amount: string; subtract?: boolean }) {
  const { ui, palette } = useUI();
  return <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}><Text style={[ui.body, { flex: 1, minWidth: 0 }]}>{label}</Text><Text style={[ui.body, { fontVariant: ['tabular-nums'], color: balanceColor(subtract ? -BigInt(amount) : amount, palette) }]}>{subtract ? '−' : '+'}{formatMoney(amount)}</Text></View>;
}

function LedgerDetails({ group, selfId }: { group: Group; selfId: string }) {
  const { ui } = useUI(), [limit, setLimit] = useState(20);
  const names = (values: Record<string, string>) => Object.entries(values).filter(([, value]) => value !== '0').map(([id, value]) => `${nameFor(group, selfId, id)} ${formatMoney(value)}`).join(', ');
  const entries = [...group.expenses.map(bill => ({ key: `bill:${bill.id}`, date: bill.date, title: `${bill.description} · ${formatMoney(bill.total)}`, detail: `${bill.deleted ? 'Reversed. No effect on balances. ' : ''}Paid: ${names(bill.paid)}. Shares: ${names(bill.shares)}.` })),
    ...group.settlements.map(payment => ({ key: `payment:${payment.id}`, date: payment.date, title: `${nameFor(group, selfId, payment.sender)} to ${nameFor(group, selfId, payment.recipient)} · ${formatMoney(payment.amount)}`, detail: payment.reversed ? 'Payment record reversed. No effect on balances.' : 'Recorded payment.' }))]
    .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '') || a.key.localeCompare(b.key));
  return <>
    {entries.slice(0, limit).map(entry => <View key={entry.key} style={{ gap: 3 }}><Text style={ui.body}>{entry.title}</Text><Text style={ui.caption}>{entry.date ? new Date(`${entry.date}T12:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : 'Date unavailable'}</Text><Text style={ui.caption}>{entry.detail}</Text></View>)}
    {!entries.length && <Text style={ui.caption}>No bills or payment records.</Text>}
    {entries.length > limit && <Button title="Show more records" kind="text" onPress={() => setLimit(value => value + 20)} />}
    {group.opening_balance && <><SectionHeading>Starting balances</SectionHeading><Text style={ui.caption}>{group.opening_balance.accepted ? 'Agreed starting balances are included.' : 'Waiting for agreement. These amounts are not included.'}</Text>{Object.entries(group.opening_balance.balances).map(([id, amount]) => <Text key={id} style={ui.body}>{netText(nameFor(group, selfId, id), amount)}</Text>)}</>}
  </>;
}

function ExplanationBody({ value, selfId }: { value: Explanation; selfId: string }) {
  const { ui } = useUI(), { group, plan, index, people } = value;
  const own = people.find(person => person.id === selfId)!, chosen = plan[index], sender = nameFor(group, selfId, chosen.sender), recipient = nameFor(group, selfId, chosen.recipient);
  return <>
    <Text style={ui.body}>Suggested payment</Text>
    <Text style={ui.section}>{sender} to {recipient === 'You' ? 'you' : recipient} · {formatMoney(chosen.amount)}</Text>
    <SectionHeading>Your balance</SectionHeading>
    <CalculationLine label="Bills you paid" amount={own.paid} />
    <CalculationLine label="Your share of the bills" amount={own.share} subtract />
    {own.sent !== '0' && <CalculationLine label="Payments you recorded sending" amount={own.sent} />}
    {own.received !== '0' && <CalculationLine label="Payments recorded to you" amount={own.received} subtract />}
    {own.opening !== '0' && <CalculationLine label="Agreed starting balance" amount={(BigInt(own.opening) < 0n ? -BigInt(own.opening) : BigInt(own.opening)).toString()} subtract={BigInt(own.opening) < 0n} />}
    <Text style={ui.section}>{netText('You', own.balance)}</Text>
    <Text style={ui.caption}>We add up everyone's bills and recorded payments, then suggest who can pay whom to settle the group. A suggested payment can cover bills involving other people.</Text>
    <DetailDialog icon="payment" title="How this payment fits">
      <Text style={ui.body}>{index ? 'If the earlier suggested payments below are made, ' : ''}{sender === 'You' && index ? 'you' : sender} {sender === 'You' ? 'owe' : 'owes'} {formatMoney(value.owing)}. {recipient} {recipient === 'You' ? 'are' : 'is'} owed {formatMoney(value.owed)}. This step uses the smaller amount, {formatMoney(chosen.amount)}.</Text>
      <SectionHeading>Everyone's balance</SectionHeading>
      {people.map(person => <Text key={person.id} style={ui.body}>{netText(person.name, person.balance)}</Text>)}
      <SectionHeading>Suggested payments in order</SectionHeading>
      {plan.map((row, step) => <Text key={`${row.sender}:${row.recipient}`} style={ui.body}>{step + 1}. {nameFor(group, selfId, row.sender)} to {nameFor(group, selfId, row.recipient)} · {formatMoney(row.amount)}{step === index ? ' · This payment' : ''}</Text>)}
    </DetailDialog>
    <DetailDialog icon="bill" title="Bills and recorded payments"><LedgerDetails group={group} selfId={selfId} /></DetailDialog>
    {value.pending && <Text style={ui.caption}>Includes changes waiting to sync.</Text>}
  </>;
}

export default function BalanceExplanation({ selection, currentKey, onClose }: { selection: BalanceSelection | null; currentKey: string; onClose: () => void }) {
  const { ui } = useUI(), { height } = useWindowDimensions(), insets = useSafeAreaInsets();
  const [result, setResult] = useState<{ value: Explanation; saved: boolean } | null>(null), [error, setError] = useState(''), [retry, setRetry] = useState(0);
  const stale = !!selection && balanceKey(selection.group, selection.commands) !== currentKey;
  function close() { onClose(); requestAnimationFrame(() => selection?.restoreFocus()); }
  useEffect(() => {
    let active = true; setResult(null); setError('');
    if (selection) void (async () => {
      try {
        const source = selection.load ? await selection.load(selection.accepted) : { group: selection.accepted, saved: true };
        const value = explainTransfer(source.group, selection.group, selection.selfId, selection.transfer, selection.commands);
        if (active) setResult({ value, saved: source.saved });
      } catch (cause) { if (active) setError(cause instanceof Error ? cause.message : 'Could not load the breakdown. Try again.'); }
    })();
    return () => { active = false; };
  }, [selection, retry]);
  const maxHeight = Math.max(180, height - insets.top - insets.bottom - 48);
  return <KeyboardDialog visible={!!selection} onDismiss={close} maxHeight={maxHeight}>
    <View style={{ flexShrink: 1 }}>
      <Dialog.Title aria-level={2}>Why this amount?</Dialog.Title>
      <DialogScrollBody maxHeight={Math.max(80, maxHeight - 150)} gap={12}>
        {stale ? <Text accessibilityRole="alert" style={ui.error}>{changedBalance}</Text> : error ? <><Text accessibilityRole="alert" style={ui.error}>{error}</Text><Button title="Try again" kind="text" onPress={() => setRetry(value => value + 1)} /></> : !result || !selection ? <Text accessibilityLiveRegion="polite" style={ui.caption}>Loading the full breakdown…</Text> : <><ExplanationBody value={result.value} selfId={selection.selfId} />{result.saved && <Text style={ui.caption}>Saved on this device.</Text>}</>}
      </DialogScrollBody>
      <Dialog.Actions><Button title="Close" accessibilityLabel="Close explanation" kind="text" onPress={close} /></Dialog.Actions>
    </View>
  </KeyboardDialog>;
}
