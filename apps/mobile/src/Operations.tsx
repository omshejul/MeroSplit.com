import React, { useState } from 'react';
import { Alert, Button, Share, Text, TextInput, View } from 'react-native';
import * as Crypto from 'expo-crypto';
import { accountOwner, request, syncOutbox } from './api';
import { formatMoney, rupeesToPaise } from './accounting';
import { getDatabase, saveSession, shareJson } from './native';
import { enqueue, pendingCommands, readGroup, wipeAccount } from './storage';
import type { Group, Session } from './types';

type Props = { session: Session; group: Group | null; paused: boolean; busy: boolean; run: (action: () => Promise<string | void>) => Promise<void>; afterDelete: () => void };
function Input({ label, value, set }: { label: string; value: string; set: (value: string) => void }) {
  return <View><Text>{label}</Text><TextInput accessibilityLabel={label} autoCapitalize="none" autoCorrect={false} value={value} onChangeText={set} style={{ borderWidth: 1, borderColor: '#888', minHeight: 44, padding: 8 }} /></View>;
}

export default function Operations({ session, group, paused, busy, run, afterDelete }: Props) {
  const [result, setResult] = useState(''), [vpa, setVpa] = useState(''), [participant, setParticipant] = useState('');
  const [inviteId, setInviteId] = useState(''), [token, setToken] = useState(''), [inviteUrl, setInviteUrl] = useState('');
  const [opening, setOpening] = useState('{}'), [source, setSource] = useState(''), [cutoff, setCutoff] = useState(''), [openingId, setOpeningId] = useState('');
  const [sender, setSender] = useState(''), [recipient, setRecipient] = useState(''), [amount, setAmount] = useState('');
  const [attemptId, setAttemptId] = useState(''), [settlementId, setSettlementId] = useState('');
  const [participantName, setParticipantName] = useState('');
  function online() { if (paused) throw new Error('Enable sync for this online operation.'); }
  async function groupCommand(path: string, body: Record<string, unknown>) {
    online(); if (!group) throw new Error('Open a shared group.');
    const db = await getDatabase(), owner = accountOwner(session), id = Crypto.randomUUID();
    if ((await pendingCommands(db, owner)).length) throw new Error('Sync or resolve saved commands before this online operation.');
    await enqueue(db, owner, { command_id: id, group_id: group.id, method: 'POST', path, body: { ...body, command_id: id }, state: 'pending', error: null });
    const receipts = await syncOutbox(db, session), receipt = receipts.at(-1) ?? {};
    setResult(JSON.stringify(receipt, null, 2));
    if (typeof receipt.url === 'string') setInviteUrl(receipt.url);
    return 'Operation accepted. Review details below.';
  }
  const action = (work: () => Promise<string | void>) => () => void run(work);
  const groupPath = group ? `/groups/${group.id}` : '';
  return <View style={{ gap: 10, marginTop: 16 }}>
    <Text style={{ fontSize: 18, fontWeight: '600' }}>Sharing and payment records</Text>
    <Text>Online operations use server permissions. Account email verification and bank verification are not provided by this pilot.</Text>
    <Button title="Read my account and payment profile" disabled={busy || paused} onPress={action(async () => { online(); setResult(JSON.stringify(await request(session, '/me'), null, 2)); return 'Account loaded.'; })} />
    <Input label="My UPI address" value={vpa} set={setVpa} />
    <Button title="Save my UPI address" disabled={busy || paused} onPress={action(async () => { online(); setResult(JSON.stringify(await request(session, '/me/payment-profile', 'PUT', { vpa }), null, 2)); return 'Your payment profile updated.'; })} />
    <Input label="Invite token to inspect or claim" value={token} set={setToken} />
    <Button title="Inspect scoped invitation" disabled={busy || paused} onPress={action(async () => { online(); setResult(JSON.stringify(await request(session, `/invites/${encodeURIComponent(token)}`), null, 2)); return 'Scoped invitation loaded.'; })} />
    <Button title="Request claim of invited participant" disabled={busy || paused} onPress={action(async () => { online(); setResult(JSON.stringify(await request(session, `/invites/${encodeURIComponent(token)}/claim`, 'POST', { command_id: Crypto.randomUUID() }), null, 2)); return 'Claim requested. Organizer approval is required.'; })} />
    {group && <>
      <Input label="New unclaimed participant name" value={participantName} set={setParticipantName} />
      <Button title="Add participant to group" disabled={busy || paused} onPress={action(() => groupCommand(`${groupPath}/participants`, { id: Crypto.randomUUID(), name: participantName.trim() }))} />
      <Input label="Participant ID to invite" value={participant} set={setParticipant} />
      <Button title="Create scoped invite" disabled={busy || paused} onPress={action(() => groupCommand(`${groupPath}/invites`, { participant_id: participant }))} />
      {!!inviteUrl && <><Text selectable>{inviteUrl}</Text><Button title="Share this invite using system sheet" disabled={busy} onPress={action(async () => { await Share.share({ message: inviteUrl }); return 'Share sheet completed.'; })} /></>}
      <Text selectable>Organizer-visible invites and claims: {JSON.stringify((group as unknown as Record<string, unknown>).invites ?? [])}</Text>
      <Input label="Invite ID to approve or revoke" value={inviteId} set={setInviteId} />
      <Button title="Approve displayed claimant" disabled={busy || paused} onPress={() => Alert.alert('Approve exact claimant?', 'Compare the invitation, participant and claimant identity above first. Names and email similarity do not establish identity.', [{ text: 'Cancel', style: 'cancel' }, { text: 'Approve', onPress: action(() => groupCommand(`${groupPath}/invites/${encodeURIComponent(inviteId)}/approve`, {})) }])} />
      <Button title="Revoke invitation" disabled={busy || paused} onPress={action(() => groupCommand(`${groupPath}/invites/${encodeURIComponent(inviteId)}/revoke`, {}))} />
      <Input label="Opening balances JSON, signed paise strings" value={opening} set={setOpening} /><Input label="Opening balance source" value={source} set={setSource} /><Input label="Opening balance cutoff YYYY-MM-DD" value={cutoff} set={setCutoff} />
      <Button title="Propose balanced opening entry" disabled={busy || paused} onPress={action(() => groupCommand(`${groupPath}/opening-balances`, { id: Crypto.randomUUID(), balances: JSON.parse(opening), source, cutoff }))} />
      <Text selectable>Opening entry: {JSON.stringify((group as unknown as Record<string, unknown>).opening_balance ?? null)}</Text><Input label="Opening entry ID to acknowledge" value={openingId} set={setOpeningId} />
      <Button title="Acknowledge my opening balance" disabled={busy || paused} onPress={action(() => groupCommand(`${groupPath}/opening-balances/${encodeURIComponent(openingId)}/acknowledge`, {}))} />
      <Input label="Payment attempt sender ID" value={sender} set={setSender} /><Input label="Payment attempt recipient ID" value={recipient} set={setRecipient} /><Input label="Attempt amount in rupees" value={amount} set={setAmount} />
      <Text selectable>Recipient profile to review: {JSON.stringify(group.participants.find(p => p.id === recipient)?.payment_profile ?? null)}. This address is self-entered, not bank verified.</Text>
      <Button title="Prepare repayment details. No transfer." disabled={busy || paused} onPress={action(async () => {
        const profile = group.participants.find(p => p.id === recipient)?.payment_profile;
        if (!profile) throw new Error('Recipient must claim their participant and add a payment profile. Sync to refresh.');
        const result = await groupCommand(`${groupPath}/payment-attempts`, { id: Crypto.randomUUID(), sender, recipient, amount: rupeesToPaise(amount), group_version: group.version, payee_version: profile.version });
        const snapshot = await readGroup(await getDatabase(), accountOwner(session), group.id);
        const actual = snapshot?.group.payment_attempts?.find(attempt => attempt.sender === sender && attempt.recipient === recipient && ['prepared', 'reported'].includes(attempt.state));
        if (actual) setAttemptId(actual.id);
        return result;
      })} />
      {(group.payment_attempts ?? []).map(attempt => <Text selectable key={attempt.id}>Attempt {attempt.id}: {attempt.state}. Quoted {formatMoney(attempt.amount)}. {attempt.recorded_amount ? `Actually recorded ${formatMoney(attempt.recorded_amount)}.` : 'No settlement recorded.'} Settlement ID: {attempt.settlement_id ?? 'none'}</Text>)}<Input label="Payment attempt ID" value={attemptId} set={setAttemptId} />
      <Button title="Check and show copyable payment details" disabled={busy || paused} onPress={action(async () => { online(); setResult(JSON.stringify(await request(session, `${groupPath}/payment-attempts/${encodeURIComponent(attemptId)}/launch`), null, 2)); return 'Details loaded. Pay outside this pilot and review the bank app recipient.'; })} />
      <Button title="I paid outside the app. Request receipt acknowledgment." disabled={busy || paused} onPress={action(() => groupCommand(`${groupPath}/payment-attempts/${encodeURIComponent(attemptId)}/report`, {}))} />
      <Button title="I received this payment" disabled={busy || paused} onPress={() => Alert.alert('Confirm receipt?', 'Check your own bank/payment app first. This posts one bookkeeping settlement; it does not independently verify the bank.', [{ text: 'Cancel', style: 'cancel' }, { text: 'Received', onPress: action(() => groupCommand(`${groupPath}/payment-attempts/${encodeURIComponent(attemptId)}/confirm`, {})) }])} />
      <Button title="Cancel unreported attempt" disabled={busy || paused} onPress={action(() => groupCommand(`${groupPath}/payment-attempts/${encodeURIComponent(attemptId)}/cancel`, {}))} />
      <Input label="Settlement ID to reverse in ledger" value={settlementId} set={setSettlementId} /><Button title="Reverse bookkeeping settlement" disabled={busy || paused} onPress={() => Alert.alert('Reverse ledger record?', 'This changes accounting only. It cannot recall any bank transfer.', [{ text: 'Cancel', style: 'cancel' }, { text: 'Reverse record', onPress: action(() => groupCommand(`${groupPath}/settlements/${encodeURIComponent(settlementId)}/reverse`, {})) }])} />
      <Button title="Archive group" disabled={busy || paused} onPress={action(() => groupCommand(`${groupPath}/archive`, { archived: true }))} /><Button title="Reopen group" disabled={busy || paused} onPress={action(() => groupCommand(`${groupPath}/archive`, { archived: false }))} />
    </>}
    <Text selectable>{result}</Text>
    <Button title="Export account JSON" disabled={busy || paused} onPress={action(async () => { online(); await shareJson('splitdumb-account', await request(session, '/account/export')); return 'Account export shared.'; })} />
    <Button title="Delete account" disabled={busy || paused} onPress={() => Alert.alert('Delete account?', 'Login and private identifiers will be removed. Shared history remains anonymized for other participants. Export first. Unsent account changes on this phone will be removed.', [{ text: 'Cancel', style: 'cancel' }, { text: 'Delete account', style: 'destructive', onPress: action(async () => { online(); await request(session, '/account', 'DELETE'); await wipeAccount(await getDatabase(), accountOwner(session)); await saveSession(null); afterDelete(); return 'Account deleted.'; }) }])} />
  </View>;
}
