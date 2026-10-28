import { ErrorState, LoadingState } from './UIStates';
import { CloseDialogActions } from './DialogParts';
import { ErrorText } from './ui';
import { Dialog } from './DialogParts';
import React, { useEffect, useState } from 'react';
import { StyleSheet, View, useWindowDimensions } from 'react-native';
import { Text } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { formatMoney, type Transfer } from './accounting';
import { balanceKey, changedBalance, explainTransfer } from './balanceExplanation';
import type { BalanceSource } from './balanceExplanationStorage';
import type { Command, Group } from './types';
import KeyboardDialog from './KeyboardDialog';
import { DialogScrollBody } from './DialogParts';
import { balanceColor, Button, Icon, IconBadge, SectionHeading, useUI, type IconName } from './ui';

export type BalanceSelection = { group: Group; accepted: Group; commands: Command[]; selfId: string; transfer: Transfer; restoreFocus: () => void; load?: (expected: Group) => Promise<BalanceSource> };
type Explanation = ReturnType<typeof explainTransfer>;
const nameFor = (group: Group, selfId: string, id: string) => id === selfId ? 'You' : group.participants.find(person => person.id === id)?.name ?? 'Former member';
const netText = (name: string, amount: string) => BigInt(amount) > 0n ? `${name} ${name === 'You' ? 'are' : 'is'} owed ${formatMoney(amount)}` : BigInt(amount) < 0n ? `${name} ${name === 'You' ? 'owe' : 'owes'} ${formatMoney((-BigInt(amount)).toString())}` : `${name} ${name === 'You' ? 'are' : 'is'} settled up`;
const dateText = (date: string | null) => date ? new Date(`${date}T12:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : 'Date unavailable';
const absolute = (amount: string) => (BigInt(amount) < 0n ? -BigInt(amount) : BigInt(amount)).toString();
type HistoryRow = Explanation['history']['entries'][number] | Explanation['history']['excluded'][number];

function InlineDetails({ title, expandedTitle, icon = 'history', children }: { title: string; expandedTitle?: string; icon?: IconName; children: React.ReactNode }) {
  const { ui, palette } = useUI(), [open, setOpen] = useState(false);
  return <View style={{ borderTopWidth: StyleSheet.hairlineWidth, borderColor: palette.line }}>
    <Button kind="plain" accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityLabel={open ? expandedTitle ?? title : title} onPress={() => setOpen(value => !value)} style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 52, paddingVertical: 12, backgroundColor: pressed ? palette.soft : undefined })}>
      <Icon name={icon} size={20} color={palette.muted} /><Text style={[ui.body, { flex: 1 }]}>{open ? expandedTitle ?? title : title}</Text><View style={{ transform: [{ rotate: open ? '180deg' : '0deg' }] }}><Icon name="down" size={18} color={palette.muted} /></View>
    </Button>
    {open && <View style={{ gap: 16, paddingBottom: 12 }}>{children}</View>}
  </View>;
}

function balanceText(group: Group, selfId: string, amount: string, past = false) {
  if (amount === '0') return 'Settled up · ' + formatMoney('0');
  if (group.participants.length !== 2) return past ? `You ${BigInt(amount) > 0n ? 'were owed' : 'owed'} ${formatMoney(absolute(amount))}` : netText('You', amount);
  const other = group.participants.find(person => person.id !== selfId)!.name;
  return BigInt(amount) < 0n ? `You ${past ? 'owed' : 'owe'} ${other} ${formatMoney(absolute(amount))}` : `${other} ${past ? 'owed' : 'owes'} you ${formatMoney(amount)}`;
}

function RecordRow({ row, group, selfId, current = false }: { row: HistoryRow; group: Group; selfId: string; current?: boolean }) {
  const { ui, palette } = useUI();
  const bill = row.kind === 'bill' ? row.bill : null, payment = row.kind === 'payment' ? row.payment : null;
  const paid = bill ? Object.entries(bill.paid).filter(([, amount]) => BigInt(amount) > 0n).map(([id, amount]) => `${nameFor(group, selfId, id)} paid ${formatMoney(amount)}`).join(', ') : '';
  const title = bill ? bill.description : payment!.sender === selfId ? `You paid ${nameFor(group, selfId, payment!.recipient)}` : `${nameFor(group, selfId, payment!.sender)} paid you`;
  return <View style={{ gap: 4 }}>
    <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: 6 }}><Text style={ui.body}>{title}</Text><Text style={ui.caption}>{dateText(row.date)}</Text></View>
    <Text style={ui.caption}>{bill ? `${paid}. Your share ${formatMoney(bill.shares[selfId] ?? '0')}.` : `Recorded payment of ${formatMoney(payment!.amount)}.`}</Text>
    {row.excluded ? <Text style={ui.caption}>Reversed. No effect on balances.</Text> : 'balance' in row && row.balance !== null ? <Text style={[ui.body, { color: balanceColor(row.balance, palette) }]}>{balanceText(group, selfId, row.balance, !current)}</Text> : <Text style={ui.caption}>Balance effect: {BigInt(row.effect) < 0n ? '−' : '+'}{formatMoney(absolute(row.effect))}</Text>}
  </View>;
}

function HistoryRecords({ rows, group, selfId }: { rows: HistoryRow[]; group: Group; selfId: string }) {
  const { ui } = useUI(), [limit, setLimit] = useState(20);
  return <>
    {rows.slice(0, limit).map((row, index) => <RecordRow key={row.key} row={row} group={group} selfId={selfId} current={index === rows.length - 1} />)}
    {!rows.length && <Text style={ui.caption}>No bills or recorded payments changed your balance.</Text>}
    {rows.length > limit && <Button title="Show more records" kind="text" onPress={() => setLimit(value => value + 20)} />}
  </>;
}

function ExplanationBody({ value, selfId }: { value: Explanation; selfId: string }) {
  const { ui, palette } = useUI(), { group, plan, index, people, history } = value;
  const own = people.find(person => person.id === selfId)!, chosen = plan[index], sender = nameFor(group, selfId, chosen.sender), recipient = nameFor(group, selfId, chosen.recipient), direct = people.length === 2;
  const bill = history.single;
  const otherId = direct ? group.participants.find(person => person.id !== selfId)!.id : '';
  const share = bill && BigInt(bill.paid[selfId] ?? '0') === 0n ? { label: 'Your share', amount: bill.shares[selfId] ?? '0' } : bill && bill.paid[selfId] === bill.total ? { label: `${nameFor(group, selfId, otherId)}'s share`, amount: bill.shares[otherId] ?? '0' } : { label: 'Effect on your balance', amount: absolute(own.balance) };
  return <>
    {value.pending && <Text style={ui.caption}>Includes changes waiting to sync.</Text>}
    <View style={{ gap: 6 }}>
      <Text style={ui.body}>{direct ? sender === 'You' ? `You owe ${recipient}` : `${sender} owes you` : 'Suggested payment'}</Text>
      {!direct && <Text style={ui.body}>{sender} to {recipient === 'You' ? 'you' : recipient}</Text>}
      <Text style={[ui.amount, { fontSize: 36, lineHeight: 44, textAlign: 'left', flexShrink: 1, color: balanceColor(own.balance, palette) }]}>{formatMoney(chosen.amount)}</Text>
      <Text style={ui.body}>{bill ? `${BigInt(bill.paid[selfId] ?? '0') === 0n ? 'Your share of' : 'From'} ${bill.description}.` : 'Your balance combines bills and recorded payments.'}{history.settledDate ? ` Your earlier balance was settled on ${dateText(history.settledDate)}.` : ''}</Text>
    </View>
    {bill ? <View style={{ gap: 12, marginVertical: 12 }}>
      <SectionHeading>What makes up {formatMoney(absolute(own.balance))}</SectionHeading>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}><IconBadge name="bill" /><View style={{ flex: 1, gap: 4 }}><Text style={ui.body}>{bill.description}</Text><Text style={ui.caption}>{dateText(bill.date)}</Text></View><Text style={ui.body}>{formatMoney(bill.total)}</Text></View>
      <Text style={ui.caption}>{Object.entries(bill.paid).filter(([, amount]) => BigInt(amount) > 0n).map(([id, amount]) => `${nameFor(group, selfId, id)} paid ${formatMoney(amount)}`).join(', ')}</Text>
      {BigInt(bill.paid[selfId] ?? '0') > 0n && bill.paid[selfId] !== bill.total && <Text style={ui.caption}>Your share {formatMoney(bill.shares[selfId] ?? '0')}.</Text>}
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}><Text style={ui.body}>{share.label}</Text><Text style={ui.body}>{formatMoney(share.amount)}</Text></View>
      {bill.split.mode === 'equal' && bill.split.values[selfId] === '1' && bill.split.values[otherId] === '1' && <Text style={ui.caption}>Split equally between you and {nameFor(group, selfId, otherId)}.</Text>}
      {history.settledDate && <Text style={ui.caption}>No amount carried over from earlier bills.</Text>}
    </View> : <View style={{ gap: 12, marginVertical: 12 }}>
      <SectionHeading>Recent changes to your balance</SectionHeading>
      {history.recent.slice(-3).map(row => <RecordRow key={row.key} row={row} group={group} selfId={selfId} current={row.key === history.entries.at(-1)?.key} />)}
      {history.recent.length > 3 && <Text style={ui.caption}>All {history.recent.length} changes are in the running balance below.</Text>}
      {!history.recent.length && <Text style={ui.body}>{netText('You', own.opening)} from the agreed starting balance.</Text>}
    </View>}
    {!direct && <Text style={ui.caption}>{netText('You', own.balance)} across this group. Group balances are combined to suggest repayments, including bills involving other people.</Text>}
    <InlineDetails title="Show running balance" expandedTitle="Hide running balance">
      <Text style={ui.caption}>{history.ordered ? 'Based on current bills and recorded payment dates. Balances are shown after each date.' : 'Some records have no date or predate the agreed starting balance. Their effects are shown below; a chronological running balance is unavailable.'}</Text>
      {group.opening_balance?.accepted && <><SectionHeading>Agreed starting balance</SectionHeading><Text style={ui.body}>{balanceText(group, selfId, history.opening, true)}</Text><Text style={ui.caption}>{dateText(group.opening_balance.cutoff)} · {group.opening_balance.source}</Text></>}
      <HistoryRecords rows={history.entries} group={group} selfId={selfId} />
      {group.opening_balance && !group.opening_balance.accepted && <Text style={ui.caption}>The proposed starting balance is waiting for agreement and is not included.</Text>}
    </InlineDetails>
    {!!history.excluded.length && <InlineDetails title={`${history.excluded.length} reversed record${history.excluded.length === 1 ? '' : 's'} excluded`} icon="refresh"><HistoryRecords rows={history.excluded} group={group} selfId={selfId} /></InlineDetails>}
    {!direct && <InlineDetails title="Group payment plan" icon="payment">
      {people.map(person => <Text key={person.id} style={ui.body}>{netText(person.name, person.balance)}</Text>)}
      <SectionHeading>Suggested payments</SectionHeading>
      {plan.map((row, step) => <Text key={`${row.sender}:${row.recipient}`} style={ui.body}>{nameFor(group, selfId, row.sender)} to {nameFor(group, selfId, row.recipient)} · {formatMoney(row.amount)}{step === index ? ' · This payment' : ''}</Text>)}
    </InlineDetails>}
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
        {stale ? <ErrorText live>{changedBalance}</ErrorText> : error ? <ErrorState error={error} retryLabel="Try again" onRetry={() => setRetry(value => value + 1)} /> : !result || !selection ? <LoadingState label="Loading the full breakdown…" /> : <><ExplanationBody value={result.value} selfId={selection.selfId} />{result.saved && <Text style={ui.caption}>Saved on this device.</Text>}</>}
      </DialogScrollBody>
      <CloseDialogActions title="Got it" accessibilityLabel="Close explanation" kind="text" onClose={close} />
    </View>
  </KeyboardDialog>;
}
