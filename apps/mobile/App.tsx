import React, { useEffect, useRef, useState } from 'react';
import { Alert, AppState, Button, KeyboardAvoidingView, Platform, ScrollView, Share, StyleSheet, Text, TextInput, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as Crypto from 'expo-crypto';
import { accountOwner, authenticate, expensePayload, request, syncOutbox } from './src/api';
import { formatMoney, rupeesToPaise, validateExpense } from './src/accounting';
import type { Amounts, Split } from './src/accounting';
import { emptyGroup, previewPending, putLocalExpense, recalculateLocal } from './src/ledger';
import { getDatabase, localSelfTest, saveSession, savedSession, shareJson, shareText } from './src/native';
import { discardCommand, enqueue, listGroups, pendingCommands, publishLocal, readDraft, readGroup, replaceCommand, saveDraft, saveGroup, wipeAccount } from './src/storage';
import type { CachedGroup, Command, Expense, Group, Session } from './src/types';
import Operations from './src/Operations';
import { nativeAccountingTest, nativeServerTest } from './src/selfTest';

const uuid = () => Crypto.randomUUID();
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const errorMessage = (e: unknown) => e instanceof Error ? e.message : 'Operation failed.';
const rupeeInput = (paise: string) => `${BigInt(paise) / 100n}.${(BigInt(paise) % 100n).toString().padStart(2, '0')}`;
function Field({ label, value, onChange, secret = false }: { label: string; value: string; onChange: (value: string) => void; secret?: boolean }) {
  return <View style={styles.field}><Text>{label}</Text><TextInput accessibilityLabel={label} style={styles.input} value={value} onChangeText={onChange} autoCapitalize="none" autoCorrect={false} secureTextEntry={secret} /></View>;
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null), [local, setLocal] = useState(true);
  const [base, setBase] = useState(process.env.EXPO_PUBLIC_API_URL ?? (Platform.OS === 'android' ? 'http://10.0.2.2:8000' : 'http://localhost:8000'));
  const [email, setEmail] = useState(''), [password, setPassword] = useState('');
  const [groups, setGroups] = useState<CachedGroup[]>([]), [selected, setSelected] = useState<CachedGroup | null>(null);
  const [commands, setCommands] = useState<Command[]>([]), [paused, setPaused] = useState(false), [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('Loading…'), [groupName, setGroupName] = useState('Trip'), [names, setNames] = useState('Me, Friend');
  const [description, setDescription] = useState(''), [amount, setAmount] = useState(''), [paid, setPaid] = useState('{}');
  const [mode, setMode] = useState<Split['mode']>('equal'), [values, setValues] = useState('{}'), [date, setDate] = useState(today()), [notes, setNotes] = useState('');
  const [editing, setEditing] = useState<Expense | null>(null), [selfId, setSelfId] = useState('');
  const [sender, setSender] = useState(''), [recipient, setRecipient] = useState(''), [repayment, setRepayment] = useState('');
  const [manualAttemptId, setManualAttemptId] = useState('');
  const [expenseSearch, setExpenseSearch] = useState('');
  const owner = !local && session ? accountOwner(session) : 'local';
  const currentOwner = useRef(owner); currentOwner.current = owner;
  const selection = useRef<string | null>(null);
  const actionLock = useRef(false);
  const draftScope = useRef<string | null>(null), draftWrites = useRef(Promise.resolve());

  async function load() {
    const db = await getDatabase(), scope = owner;
    const rows = await listGroups(db, scope), queue = await pendingCommands(db, scope);
    const group = selection.current ? await readGroup(db, scope, selection.current) : null;
    if (currentOwner.current === scope) { setGroups(rows); setCommands(queue); setSelected(group); }
  }
  async function run(action: () => Promise<string | void>) {
    if (actionLock.current) return;
    actionLock.current = true; setBusy(true);
    try { setStatus(await action() ?? 'Saved.'); } catch (e) { setStatus(errorMessage(e)); }
    finally { await load().catch(e => setStatus(errorMessage(e))); setBusy(false); actionLock.current = false; }
  }
  function switchMode(isLocal: boolean) { draftScope.current = null; selection.current = null; setSelected(null); setEditing(null); setGroups([]); setCommands([]); setLocal(isLocal); }
  useEffect(() => { void savedSession().then(value => { setSession(value); if (value) { setBase(value.baseUrl); switchMode(false); } }).catch(e => setStatus(errorMessage(e))); }, []);
  useEffect(() => { void load().then(() => setStatus('Local data loaded.')).catch(e => setStatus(errorMessage(e))); }, [owner]);
  useEffect(() => {
    if (!selected || draftScope.current !== `${owner}|${selected.group.id}`) return;
    const groupId = selected.group.id, scope = owner;
    const body = { description, amount, paid, mode, values, date, notes, editing };
    draftWrites.current = draftWrites.current.then(async () => saveDraft(await getDatabase(), scope, groupId, body)).catch(e => setStatus(`Draft save failed: ${errorMessage(e)}`));
  }, [owner, selected?.group.id, description, amount, paid, mode, values, date, notes, editing]);
  async function openGroup(row: CachedGroup) {
    draftScope.current = null; selection.current = row.group.id;
    await draftWrites.current;
    const draft = await readDraft<{ description: string; amount: string; paid: string; mode: Split['mode']; values: string; date: string; notes: string; editing: Expense | null }>(await getDatabase(), owner, row.group.id);
    if (currentOwner.current !== owner || selection.current !== row.group.id) return;
    setSelected(row); setSelfId(row.group.participants[0]?.id ?? ''); setEditing(draft?.editing ?? null); setExpenseSearch('');
    setDescription(draft?.description ?? ''); setAmount(draft?.amount ?? ''); setPaid(draft?.paid ?? '{}');
    setMode(draft?.mode ?? 'equal'); setValues(draft?.values ?? JSON.stringify(Object.fromEntries(row.group.participants.map(p => [p.id, '1']))));
    setDate(draft?.date ?? today()); setNotes(draft?.notes ?? ''); draftScope.current = `${owner}|${row.group.id}`;
  }

  async function sync() {
    if (!session || local || paused) throw new Error('Sign in and enable sync first.');
    const db = await getDatabase(); await syncOutbox(db, session);
    const result = await request<{ groups: { id: string }[] }>(session, '/groups');
    for (const row of result.groups) await saveGroup(db, owner, await request<Group>(session, `/groups/${row.id}`), 'shared');
    return 'Sync complete.';
  }
  useEffect(() => {
    const listener = AppState.addEventListener('change', state => { if (state === 'active' && session && !local && !paused) void run(sync); });
    return () => listener.remove();
  }, [owner, session, paused]);
  const makeCommand = (groupId: string, method: Command['method'], path: string, body: Record<string, unknown>): Command => {
    const id = uuid(); return { command_id: id, group_id: groupId, method, path, body: { ...body, command_id: id }, state: 'pending', error: null };
  };
  async function finishQueue(command: Command, replacing?: string) {
    const db = await getDatabase();
    if (replacing) await replaceCommand(db, owner, replacing, command); else await enqueue(db, owner, command);
    if (!paused && session && !local) { try { await syncOutbox(db, session); return 'Accepted by server.'; } catch (e) { return `Saved on this phone. ${errorMessage(e)}`; } }
    return 'Saved on this phone. Waiting to sync.';
  }
  function edit(expense: Expense | null) {
    setEditing(expense); setDescription(expense?.description ?? ''); setAmount(expense ? rupeeInput(expense.total) : '');
    setPaid(JSON.stringify(expense?.paid ?? {})); setMode(expense?.split.mode ?? 'equal');
    setValues(JSON.stringify(expense?.split.values ?? Object.fromEntries((selected?.group.participants ?? []).map(p => [p.id, '1']))));
    setDate(expense?.date ?? today()); setNotes(expense?.notes ?? '');
  }
  function confirm(title: string, detail: string, action: () => Promise<string | void>) {
    Alert.alert(title, detail, [{ text: 'Cancel', style: 'cancel' }, { text: 'Confirm', onPress: () => void run(action) }]);
  }
  const currentCommands = commands.filter(c => c.group_id === selected?.group.id);
  let preview = selected?.group ?? null, previewError = '';
  if (preview && currentCommands.length) { try { preview = previewPending(preview, currentCommands); } catch (e) { previewError = errorMessage(e); } }
  const personName = (id: string) => selected?.group.participants.find(p => p.id === id)?.name ?? id;

  return <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}><StatusBar style="dark" /><ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
    <Text style={styles.title}>SplitDumb functional pilot</Text>
    <Text accessibilityLiveRegion="polite" testID="status">{busy ? 'Working… ' : ''}{status}</Text>
    <Text>INR only. No bank funds are transferred or verified by this app.</Text>
    <Text style={styles.section}>Account</Text>
    <Field label="Server URL" value={base} onChange={setBase} /><Field label="Email" value={email} onChange={setEmail} /><Field label="Password" value={password} onChange={setPassword} secret />
    {[false, true].map(signup => <Button key={String(signup)} title={signup ? 'Create pilot account' : 'Sign in'} disabled={busy} onPress={() => void run(async () => { const value = await authenticate(base, email, password, signup); await saveSession(value); setSession(value); setPassword(''); switchMode(false); return 'Signed in. Tap Sync to fetch groups.'; })} />)}
    {__DEV__ && <Button title="Create synthetic test account" disabled={busy} onPress={() => void run(async () => {
      const testEmail = `native-${uuid()}@splitdumb.invalid`, testPassword = `Test!${uuid()}${uuid()}`;
      const value = await authenticate(base, testEmail, testPassword, true);
      await saveSession(value); setSession(value); setEmail(testEmail); setPassword(''); switchMode(false);
      return 'Disposable account created through normal signup. Session saved securely on this device.';
    })} />}
    {session && <Text>Account: {session.email}</Text>}
    <Button title={local ? 'Viewing private local groups' : 'Use private local groups'} disabled={busy || local} onPress={() => switchMode(true)} />
    <Button title={!local ? 'Viewing account groups' : 'Use account groups'} disabled={busy || !session || !local} onPress={() => switchMode(false)} />
    {session && <Button title="Sign out and remove account device data" disabled={busy} onPress={() => confirm('Sign out?', 'Unsent account changes will be removed from this phone. Private local groups remain.', async () => {
      const response = await fetch(`${session.baseUrl}/_allauth/app/v1/auth/session`, { method: 'DELETE', headers: { 'X-Session-Token': session.token } });
      if (!response.ok && response.status !== 401) throw new Error('Could not revoke server session. Try again.');
      await wipeAccount(await getDatabase(), accountOwner(session)); await saveSession(null); setSession(null); switchMode(true); return 'Signed out.';
    })} />}
    <Button title={paused ? 'Enable sync' : 'Pause sync for offline entry'} disabled={busy} onPress={() => setPaused(value => !value)} />
    <Button title="Sync / retry saved commands" disabled={busy || !session || local || paused} onPress={() => void run(sync)} />
    <Text style={styles.section}>Groups</Text>
    {groups.map(row => <Button key={row.group.id} title={`${row.group.name} (${row.kind})`} disabled={busy} onPress={() => void run(async () => { await openGroup(row); return 'Group loaded. Unsaved expense form restored when available.'; })} />)}
    {!groups.length && <Text>No groups in this mode. Create one below.</Text>}
    <Field label="New group name" value={groupName} onChange={setGroupName} /><Field label="Participant names, comma separated. First is you." value={names} onChange={setNames} />
    <Button title="Create group" disabled={busy} onPress={() => void run(async () => {
      const participants = names.split(',').map(value => ({ id: uuid(), name: value.trim() })), group = emptyGroup(uuid(), groupName, participants), db = await getDatabase();
      selection.current = group.id; draftScope.current = `${owner}|${group.id}`; setSelfId(participants[0].id); setValues(JSON.stringify(Object.fromEntries(participants.map(p => [p.id, '1']))));
      if (local) { await saveGroup(db, owner, group, 'local'); return 'Private local group saved.'; }
      const command = makeCommand(group.id, 'POST', '/groups', { id: group.id, name: group.name, participants, self_participant_id: participants[0].id });
      await publishLocal(db, owner, group, [command]);
      if (!paused && session) { try { await syncOutbox(db, session); } catch (e) { return `Group saved on this phone. ${errorMessage(e)}`; } }
      return 'Group saved.';
    })} />
    {selected && preview && <>
      <Text style={styles.section}>{selected.group.name}</Text><Text>{selected.kind === 'local' ? 'Private local records' : `Accepted server version ${selected.group.version}`}</Text>
      <Text selectable>{selected.group.participants.map(p => `${p.name}: ${p.id}`).join('\n')}</Text>
      {selected.kind === 'local' && session && <><Field label="Your participant ID when publishing" value={selfId} onChange={setSelfId} /><Button title="Publish a copy to my account" disabled={busy} onPress={() => confirm('Publish group?', 'Names, bills and balances become visible to authorized members. The local original remains separate.', async () => {
        const group = selected.group;
        if (!group.participants.some(p => p.id === selfId)) throw new Error('Choose your participant ID.');
        const queue = [makeCommand(group.id, 'POST', '/groups', { id: group.id, name: group.name, participants: group.participants.map(({ id, name }) => ({ id, name })), self_participant_id: selfId })];
        for (const expense of group.expenses.filter(e => !e.deleted)) queue.push(makeCommand(group.id, 'POST', `/groups/${group.id}/expenses`, expensePayload(expense)));
        for (const settlement of group.settlements.filter(s => !s.reversed)) { const { id, sender, recipient, amount } = settlement; queue.push(makeCommand(group.id, 'POST', `/groups/${group.id}/settlements`, { id, sender, recipient, amount })); }
        await publishLocal(await getDatabase(), accountOwner(session), group, queue); setLocal(false);
        if (!paused) await syncOutbox(await getDatabase(), session); return 'Account copy prepared. Local original is independent.';
      })} /></>}
      {selected.group.participants.map(p => <Text key={p.id}>{p.name}: {formatMoney(selected.group.balances[p.id] ?? '0')}{currentCommands.length ? previewError ? '; pending total unavailable until sync' : `; pending preview ${formatMoney(preview!.balances[p.id] ?? '0')}` : ''}</Text>)}
      <Text>Positive means owed to the person. Negative means they owe.</Text>{!!previewError && <Text>Pending preview unavailable: {previewError}</Text>}
      {selected.group.totals && <><Text>Accepted purchase spending: {formatMoney(selected.group.totals.spending)}</Text>{selected.group.participants.map(p => <Text key={`totals-${p.id}`}>{p.name} paid {formatMoney(selected.group.totals!.paid[p.id] ?? '0')}; share {formatMoney(selected.group.totals!.shares[p.id] ?? '0')}. Repayments excluded.</Text>)}</>}
      <Text style={styles.section}>Suggested repayments</Text>
      {preview.transfers.map((t, i) => <View key={i} style={styles.row}><Button title={`${personName(t.sender)} → ${personName(t.recipient)} ${formatMoney(t.amount)}`} disabled={busy} onPress={() => { setSender(t.sender); setRecipient(t.recipient); setRepayment(rupeeInput(t.amount)); }} /><Button title="Share repayment reminder" disabled={busy || currentCommands.length > 0} onPress={() => void run(async () => {
        await Share.share({ message: `Suggested repayment in ${selected.group.name}: ${personName(t.sender)} to ${personName(t.recipient)} ${formatMoney(t.amount)}. Review the latest shared ledger before paying. SplitDumb does not verify bank transfers.` }); return 'Reminder share sheet completed.';
      })} /></View>)}
      {!preview.transfers.length && <Text>No repayment suggested in this view.</Text>}
      <Text style={styles.section}>{editing ? 'Edit expense' : 'Add expense'}</Text>
      <Field label="Description" value={description} onChange={setDescription} /><Field label="Amount in rupees" value={amount} onChange={setAmount} />
      <Text>Empty payer JSON uses the first person. Otherwise use participant IDs and paise strings.</Text><Field label="Payer amounts JSON" value={paid} onChange={setPaid} />
      {(['equal', 'exact', 'percent', 'shares'] as const).map(value => <Button key={value} title={mode === value ? `Selected: ${value}` : value} disabled={busy} onPress={() => setMode(value)} />)}
      <Text>Equal values: "1". Exact: paise. Percent: percentages. Shares: weights.</Text><Field label="Split values JSON" value={values} onChange={setValues} /><Field label="Date YYYY-MM-DD" value={date} onChange={setDate} /><Field label="Notes" value={notes} onChange={setNotes} />
      <Button title={editing ? 'Save reviewed expense revision' : 'Save expense'} disabled={busy} onPress={() => void run(async () => {
        const group = selected.group, total = rupeesToPaise(amount);
        if (!description.trim() || description.trim().length > 200 || notes.length > 2000) throw new Error('Description is required, at most 200 characters; notes at most 2000.');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) throw new Error('Enter a valid YYYY-MM-DD date.');
        const input = JSON.parse(paid) as Amounts, contributions = Object.keys(input).length ? input : { [group.participants[0].id]: total };
        const split = { mode, values: JSON.parse(values) as Amounts }, vectors = validateExpense(total, contributions, split, group.participants.map(p => p.id));
        const expense: Expense = { id: editing?.id ?? uuid(), version: editing?.version ?? 0, description: description.trim(), total, ...vectors, split, date, category: editing?.category ?? 'general', notes, deleted: false };
        let result;
        if (selected.kind === 'local') { await saveGroup(await getDatabase(), owner, putLocalExpense(group, { ...expense, version: expense.version + 1 }), 'local'); result = 'Local expense saved.'; }
        else result = await finishQueue(makeCommand(group.id, editing ? 'PUT' : 'POST', `/groups/${group.id}/expenses${editing ? `/${expense.id}` : ''}`, expensePayload(expense, !!editing)));
        edit(null); return result;
      })} />
      {editing && <Button title="Cancel edit" disabled={busy} onPress={() => edit(null)} />}
      <Field label="Filter expenses by description or notes" value={expenseSearch} onChange={setExpenseSearch} />
      {preview.expenses.filter(expense => `${expense.description} ${expense.notes}`.toLowerCase().includes(expenseSearch.trim().toLowerCase())).map(expense => <View key={expense.id} style={styles.row}><Text>{expense.description} {formatMoney(expense.total)} {expense.deleted ? '(deleted)' : ''}</Text><Text selectable>Paid {JSON.stringify(expense.paid)}{`\n`}Shares {JSON.stringify(expense.shares)}</Text>
        <Button title="Review / edit" disabled={busy || currentCommands.length > 0 || expense.deleted} onPress={() => edit(expense)} />
        <Button title={expense.deleted ? 'Restore expense' : 'Delete expense'} disabled={busy || currentCommands.length > 0} onPress={() => confirm('Change expense?', 'Original history remains visible.', async () => {
          if (selected.kind === 'local') { await saveGroup(await getDatabase(), owner, recalculateLocal({ ...selected.group, version: selected.group.version + 1, expenses: selected.group.expenses.map(e => e.id === expense.id ? { ...e, deleted: !e.deleted, version: e.version + 1 } : e) }), 'local'); return 'Local expense updated.'; }
          return finishQueue(makeCommand(selected.group.id, expense.deleted ? 'POST' : 'DELETE', `/groups/${selected.group.id}/expenses/${expense.id}${expense.deleted ? '/restore' : ''}`, { version: expense.version }));
        })} /></View>)}
      <Text style={styles.section}>Record a past payment</Text><Text>This bookkeeping action changes balances. It does not move funds.</Text>
      <Field label="Sender participant ID" value={sender} onChange={setSender} /><Field label="Recipient participant ID" value={recipient} onChange={setRecipient} /><Field label="Payment amount in rupees" value={repayment} onChange={setRepayment} />
      {selected.kind === 'shared' && <Field label="Existing payment attempt ID, if this records that same transfer" value={manualAttemptId} onChange={setManualAttemptId} />}
      <Button title="Record manual payment" disabled={busy} onPress={() => confirm('Record a payment?', 'Confirm it happened outside the app. Manual provenance remains visible.', async () => {
        const settlement = { id: uuid(), sender, recipient, amount: rupeesToPaise(repayment), provenance: 'manual_record' };
        const group = recalculateLocal({ ...selected.group, settlements: [...selected.group.settlements, settlement] });
        if (selected.kind === 'local') { await saveGroup(await getDatabase(), owner, { ...group, version: group.version + 1 }, 'local'); return 'Manual payment saved locally.'; }
        return finishQueue(makeCommand(selected.group.id, 'POST', `/groups/${selected.group.id}/settlements`, { id: settlement.id, sender, recipient, amount: settlement.amount, ...(manualAttemptId.trim() ? { attempt_id: manualAttemptId.trim() } : {}) }));
      })} />
      {preview.settlements.map(s => <Text selectable key={s.id}>{personName(s.sender)} paid {personName(s.recipient)} {formatMoney(s.amount)} ({s.provenance ?? s.method ?? 'recorded'}) {s.reversed ? '(reversed)' : ''} ID: {s.id}</Text>)}
      <Button title="Export selected group JSON" disabled={busy} onPress={() => void run(async () => { const data = selected.kind === 'shared' && session && !paused ? await request(session, `/groups/${selected.group.id}/export?format=json`) : { kind: 'local_snapshot', group: selected.group, pending_commands: currentCommands }; await shareJson(`splitdumb-${selected.group.id}`, data); return 'System share sheet completed.'; })} />
      {selected.kind === 'shared' && session && <Button title="Export accepted group CSV" disabled={busy || paused} onPress={() => void run(async () => { const csv = await request<string>(session, `/groups/${selected.group.id}/export?format=csv`, 'GET', undefined, 'text'); await shareText(`splitdumb-${selected.group.id}.csv`, csv, 'text/csv'); return 'Accepted records exported. Unsent changes are excluded.'; })} />}
    </>}
    {!!commands.length && <Text style={styles.section}>Saved commands</Text>}
    {commands.map(command => <View key={command.command_id} style={styles.row}><Text>{command.method} {command.path}: {command.state} {command.error ?? ''}</Text><Text selectable>{JSON.stringify(command.body)}</Text>
      {command.state !== 'pending' && <Button title="Load accepted group and review conflict" disabled={busy || !session || paused} onPress={() => void run(async () => { const group = await request<Group>(session!, `/groups/${command.group_id}`); await saveGroup(await getDatabase(), owner, group, 'shared'); selection.current = group.id; return 'Accepted version loaded. Compare it with the saved command.'; })} />}
      {command.state === 'conflict' && command.method === 'PUT' && command.path.includes('/expenses/') && <Button title="Reapply displayed expense draft to current revision" disabled={busy || !session || paused} onPress={() => confirm('Reapply draft?', 'This replaces the current expense with the displayed saved values. Review both first.', async () => {
        const group = await request<Group>(session!, `/groups/${command.group_id}`), expense = group.expenses.find(e => e.id === command.body.id);
        if (!expense) throw new Error('Expense missing. Keep or discard the saved draft.');
        return finishQueue(makeCommand(group.id, 'PUT', command.path, { ...command.body, version: expense.version }), command.command_id);
      })} />}
      <Button title="Discard saved command" disabled={busy} onPress={() => confirm('Discard saved change?', 'Accepted records remain. A lost response may mean this request was already accepted. Sync to check.', async () => { await discardCommand(await getDatabase(), owner, command.command_id); return 'Saved command discarded.'; })} />
    </View>)}
    {session && !local && <Operations session={session} group={selected?.kind === 'shared' ? selected.group : null} paused={paused} busy={busy} run={run} afterDelete={() => { setSession(null); switchMode(true); }} />}
    <Button title="Run local SQLite self-test" disabled={busy} onPress={() => void run(localSelfTest)} />
    <Button title="Run native accounting fixtures" disabled={busy} onPress={() => void run(async () => nativeAccountingTest())} />
    {session && !local && <Button title="Run native/server synthetic self-test" disabled={busy || paused} onPress={() => confirm('Create synthetic test records?', 'This creates a test group in your account, exercises bookkeeping and exports, and makes no bank transfer.', () => nativeServerTest(session))} />}
  </ScrollView></KeyboardAvoidingView>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: 'white' }, content: { padding: 20, paddingTop: 52, paddingBottom: 60, gap: 10 },
  title: { fontSize: 22, fontWeight: '600' }, section: { fontSize: 18, fontWeight: '600', marginTop: 16 },
  field: { gap: 4 }, input: { borderWidth: 1, borderColor: '#888', minHeight: 44, padding: 8, color: '#111' }, row: { borderTopWidth: 1, borderColor: '#ccc', paddingVertical: 10, gap: 6 },
});
