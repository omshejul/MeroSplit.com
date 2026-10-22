import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, AppState, BackHandler, KeyboardAvoidingView, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import * as Crypto from 'expo-crypto';
import { accountOwner, authenticate, expensePayload, request, syncOutbox } from './src/api';
import { formatMoney } from './src/accounting';
import { emptyGroup, previewPending, putLocalExpense, recalculateLocal } from './src/ledger';
import { getDatabase, savedSession, savedSyncPaused, saveSession, saveSyncPaused, shareJson, shareText } from './src/native';
import { discardCommand, discardUnsentGroup, enqueue, listGroups, pendingCommands, publishLocal, readDraft, replaceCommand, saveDraft, saveGroup, wipeAccount } from './src/storage';
import GroupScreen, { ExpenseDetail, position } from './src/GroupScreen';
import ExpenseForm from './src/ExpenseForm';
import type { ExpenseFormDraft } from './src/ExpenseForm';
import SettleForm from './src/SettleForm';
import MembersScreen from './src/MembersScreen';
import SavedChangeScreen from './src/SavedChangeScreen';
import type { CachedGroup, Command, Expense, Group, Session, Settlement } from './src/types';
import { Avatar, Button, colors, Disclosure, Icon, UIProvider, ui } from './src/ui';
import { SegmentedButtons, Switch } from 'react-native-paper';

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? (Platform.OS === 'android' ? 'http://10.0.2.2:8000' : 'http://localhost:8000');
const uuid = () => Crypto.randomUUID();
type Screen = 'home' | 'create' | 'group' | 'expense' | 'expenseDetail' | 'settle' | 'members' | 'login' | 'review' | 'activity' | 'profile' | 'sync' | 'data';
type Transfer = { sender: string; recipient: string; amount: string };
function Input({ label, value, onChange, secret = false }: { label: string; value: string; onChange: (value: string) => void; secret?: boolean }) {
  return <View style={s.field}><Text style={ui.label}>{label}</Text><TextInput accessibilityLabel={label} style={ui.input} value={value} onChangeText={onChange} secureTextEntry={secret} autoCorrect={false} autoCapitalize={secret || label === 'Email' || label === 'Your UPI address' ? 'none' : 'words'} autoComplete={label === 'Email' ? 'email' : secret ? 'current-password' : 'off'} keyboardType={label === 'Email' ? 'email-address' : 'default'} /></View>;
}
function AppContent() {
  const [session, setSession] = useState<Session | null>(null), [local, setLocal] = useState(true), [ready, setReady] = useState(false);
  const [groups, setGroups] = useState<CachedGroup[]>([]), [commands, setCommands] = useState<Command[]>([]);
  const [screen, setScreen] = useState<Screen>('home'), [tab, setTab] = useState('Groups'), [groupId, setGroupId] = useState<string | null>(null);
  const [expenseId, setExpenseId] = useState<string | null>(null), [draft, setDraft] = useState<ExpenseFormDraft | null>(null), [transfer, setTransfer] = useState<Transfer | undefined>();
  const [reviewCommand, setReviewCommand] = useState<Command | null>(null), [reviewInput, setReviewInput] = useState<Expense | undefined>();
  const [busy, setBusy] = useState(false), [paused, setPaused] = useState(false), [notice, setNotice] = useState('');
  const [email, setEmail] = useState(''), [password, setPassword] = useState(''), [signup, setSignup] = useState(false);
  const [groupName, setGroupName] = useState(''), [myName, setMyName] = useState('You'), [people, setPeople] = useState(['', '']);
  const [vpa, setVpa] = useState('');
  const owner = session && !local ? accountOwner(session) : 'local', ownerRef = useRef(owner); ownerRef.current = owner;
  const lock = useRef(false), draftWrites = useRef(Promise.resolve());
  const selected = groups.find(row => row.group.id === groupId) ?? null;
  const pending = commands.filter(command => command.group_id === groupId);
  const selfId = selected?.group.participants.find(person => !local && session && String(person.user_id) === session.userId)?.id ?? (local ? selected?.group.participants[0]?.id : undefined) ?? '';
  let preview = selected?.group ?? null, previewError = '';
  if (preview && pending.length) { try { preview = previewPending(preview, pending); } catch (error) { previewError = error instanceof Error ? error.message : 'Sync to review saved changes.'; } }
  const expense = preview?.expenses.find(value => value.id === expenseId);
  function navigate(value: Screen) { setNotice(''); setScreen(value); }
  function changeScope(value: Session | null, privateMode: boolean) {
    ownerRef.current = value && !privateMode ? accountOwner(value) : 'local';
    setSession(value); setLocal(privateMode); setGroups([]); setCommands([]); setGroupId(null); setExpenseId(null); setDraft(null); setVpa(''); setScreen('home');
    setReviewCommand(null); setReviewInput(undefined);
    void load(ownerRef.current).catch(error => setNotice(error.message));
  }
  async function load(scope = owner) {
    const db = await getDatabase(), rows = await listGroups(db, scope), queue = await pendingCommands(db, scope);
    if (ownerRef.current === scope) { setGroups(rows); setCommands(queue); }
  }
  async function perform<T,>(action: () => Promise<T>): Promise<T> {
    if (lock.current) throw new Error('Please wait for the current action.');
    lock.current = true; setBusy(true); setNotice('');
    try { return await action(); }
    catch (error) { setNotice(error instanceof Error ? error.message : 'Could not save. Please try again.'); throw error; }
    finally { await load().catch(() => {}); lock.current = false; setBusy(false); }
  }
  const launch = (action: () => Promise<unknown>) => { void perform(action).catch(() => {}); };
  function confirm(title: string, message: string, action: () => Promise<unknown>) {
    Alert.alert(title, message, [{ text: 'Cancel', style: 'cancel' }, { text: 'Confirm', onPress: () => launch(action) }]);
  }
  async function syncAccount(active: Session) {
    const db = await getDatabase(), scope = accountOwner(active);
    await syncOutbox(db, active);
    const rows = await request<{ groups: { id: string }[] }>(active, '/groups');
    for (const row of rows.groups) await saveGroup(db, scope, await request<Group>(active, `/groups/${row.id}`), 'shared');
    await load(scope); setNotice('');
  }
  async function sync() {
    if (!session || local || paused) throw new Error('Sign in and turn on sync to retry.');
    await syncAccount(session);
  }
  useEffect(() => { void Promise.all([savedSession(), savedSyncPaused()]).then(([value, syncPaused]) => { setPaused(syncPaused); if (value) { changeScope(value, false); setEmail(value.email); setMyName(value.email.split('@')[0]); } }).catch(() => setNotice('Could not restore sign-in. Your saved records remain on this phone.')).finally(() => setReady(true)); }, []);
  useEffect(() => { if (ready) void load().catch(error => setNotice(error.message)); }, [owner, ready]);
  useEffect(() => {
    if (!ready || !session || local || paused) return;
    if (!lock.current) launch(() => sync());
    const listener = AppState.addEventListener('change', state => { if (state === 'active' && !lock.current) launch(() => sync()); });
    return () => listener.remove();
  }, [owner, ready, paused, session?.token]);
  function back() {
    if (screen === 'expense' || screen === 'expenseDetail' || screen === 'settle' || screen === 'members' || screen === 'review') navigate('group');
    else navigate('home');
  }
  useEffect(() => { const event = BackHandler.addEventListener('hardwareBackPress', () => { if (busy) return true; if (screen === 'home') return false; back(); return true; }); return () => event.remove(); }, [screen, busy]);
  function command(method: Command['method'], path: string, body: Record<string, unknown>): Command {
    const id = uuid(); return { command_id: id, group_id: groupId!, method, path, body: { ...body, command_id: id }, state: 'pending', error: null };
  }
  async function queue(value: Command, replacing?: string) {
    if (replacing) await replaceCommand(await getDatabase(), owner, replacing, value);
    else await enqueue(await getDatabase(), owner, value);
    if (session && !local && !paused) {
      try { await syncOutbox(await getDatabase(), session); return; }
      catch (error) { setNotice(`Saved on this phone. ${error instanceof Error ? error.message : 'Retry sync when online.'}`); return; }
    }
    setNotice('Saved on this phone. Waiting to sync.');
  }
  async function localSave(group: Group, kind: string, data: Record<string, unknown>) {
    const activity = { sequence: group.version, actor_id: null, kind, data, created_at: new Date().toISOString() };
    await saveGroup(await getDatabase(), owner, { ...group, activity: [...group.activity, activity] }, 'local');
  }
  async function openGroup(row: CachedGroup) { await draftWrites.current; setGroupId(row.group.id); setExpenseId(null); setDraft(null); navigate('group'); }
  async function openExpense(value?: Expense) {
    await draftWrites.current;
    setReviewCommand(null); setReviewInput(undefined);
    setDraft(await readDraft<ExpenseFormDraft>(await getDatabase(), owner, groupId!));
    setExpenseId(value?.id ?? null); navigate('expense');
  }
  async function saveExpense(value: Expense) {
    await perform(async () => {
      if (!selected) throw new Error('Open a group first.');
      if (selected.group.archived) throw new Error('Reopen this group in settings before making changes.');
      if (local) await localSave(putLocalExpense(selected.group, value), expenseId ? 'expense_updated' : 'expense_added', { id: value.id, description: value.description, total: value.total });
      else await queue(command(expenseId ? 'PUT' : 'POST', `/groups/${groupId}/expenses${expenseId ? `/${value.id}` : ''}`, expensePayload(value, !!expenseId)), reviewCommand?.command_id);
      await draftWrites.current; await saveDraft(await getDatabase(), owner, groupId!, null); setDraft(null); setReviewCommand(null); setReviewInput(undefined); navigate('group');
    });
  }
  async function changeExpense(value: Expense, restore = false) {
    if (!selected) return;
    if (selected.group.archived) throw new Error('Reopen this group in settings before making changes.');
    if (local) await localSave(recalculateLocal({ ...selected.group, version: selected.group.version + 1, expenses: selected.group.expenses.map(row => row.id === value.id ? { ...row, deleted: !restore } : row) }), restore ? 'expense_restored' : 'expense_deleted', { id: value.id, description: value.description });
    else await queue(command(restore ? 'POST' : 'DELETE', `/groups/${groupId}/expenses/${value.id}${restore ? '/restore' : ''}`, { version: value.version }));
    navigate('group');
  }
  async function savePayment(value: Transfer) {
    await perform(async () => {
      if (!selected) throw new Error('Open a group first.');
      if (selected.group.archived) throw new Error('Reopen this group in settings before making changes.');
      const payment = { id: uuid(), ...value, provenance: 'manual_record' };
      if (local) await localSave(recalculateLocal({ ...selected.group, version: selected.group.version + 1, settlements: [...selected.group.settlements, payment] }), 'settlement_recorded', payment);
      else {
        const attempt = selected.group.payment_attempts?.find(attempt => attempt.sender === value.sender && attempt.recipient === value.recipient && ['prepared', 'reported'].includes(attempt.state) && !pending.some(command => command.path.endsWith('/settlements') && command.body.attempt_id === attempt.id));
        await queue(command('POST', `/groups/${groupId}/settlements`, { id: payment.id, ...value, ...(attempt ? { attempt_id: attempt.id } : {}) }));
      }
      navigate('group');
    });
  }
  async function reversePayment(value: Settlement) {
    if (!selected) return;
    if (selected.group.archived) throw new Error('Reopen this group in settings before making changes.');
    if (local) await localSave(recalculateLocal({ ...selected.group, version: selected.group.version + 1, settlements: selected.group.settlements.map(row => row.id === value.id ? { ...row, reversed: true } : row) }), 'settlement_reversed', { id: value.id });
    else await queue(command('POST', `/groups/${groupId}/settlements/${value.id}/reverse`, {}));
  }
  async function groupAction(suffix: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return perform(async () => {
      if (!session || local || paused) throw new Error('Turn on account sync for this action.');
      if (commands.length) throw new Error('Sync or discard unsent changes first.');
      await enqueue(await getDatabase(), owner, command('POST', `/groups/${groupId}${suffix}`, body));
      const receipts = await syncOutbox(await getDatabase(), session); return receipts.at(-1) ?? {};
    });
  }
  async function exportGroup(format: 'json' | 'csv') {
    await perform(async () => {
      if (!selected) return;
      if (format === 'csv') {
        if (!session || local || paused) throw new Error('Connect to export accepted shared records as CSV.');
        await shareText('merosplit-group.csv', await request<string>(session, `/groups/${groupId}/export?format=csv`, 'GET', undefined, 'text'), 'text/csv');
      } else await shareJson('merosplit-group', session && !local && !paused ? await request(session, `/groups/${groupId}/export?format=json`) : { kind: 'local_snapshot', group: selected.group, pending_commands: pending });
    });
  }
  const direct = tab === 'Friends';
  const visibleGroups = groups.filter(row => !!row.group.is_direct === direct);
  const groupPeople = groups.filter(row => !row.group.is_direct).flatMap(row => row.group.participants.filter(person => !local && session ? String(person.user_id) !== session.userId : person.id !== row.group.participants[0]?.id).map(person => ({ row, person })));
  const title = screen === 'home' ? (tab === 'Friends' ? 'People' : tab === 'Account' ? 'Me' : tab) : screen === 'login' ? (signup ? 'Create account' : 'Sign in') : screen === 'create' ? (direct ? 'Add a person' : 'New group') : screen === 'expense' ? (expenseId ? 'Edit bill' : 'Add a bill') : screen === 'expenseDetail' ? expense?.description ?? 'Bill' : screen === 'settle' ? 'Record a payment' : screen === 'members' ? 'Group settings' : screen === 'review' ? 'Review your bill' : screen === 'activity' ? 'History' : screen === 'profile' ? 'Your UPI address' : screen === 'sync' ? 'Sync settings' : screen === 'data' ? 'Your data' : selected?.group.name ?? 'Group';
  if (!ready) return <SafeAreaView style={[s.screen, s.loading]}><ActivityIndicator color={colors.accent} /><Text style={ui.caption}>Opening your groups…</Text></SafeAreaView>;
  return <SafeAreaView style={s.screen} edges={['top', 'bottom']}><StatusBar style="dark" /><KeyboardAvoidingView style={s.screen} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
    <View style={s.header}>{screen !== 'home' && <Button title={screen === 'expense' || screen === 'settle' || screen === 'create' ? 'Cancel' : 'Back'} kind="text" icon="back" disabled={busy} onPress={back} />}<Text style={s.title}>{title}</Text>{busy && <ActivityIndicator accessibilityLabel="Working" color={colors.accent} />}</View>
    <ScrollView key={`${owner}|${screen}|${groupId ?? ''}`} contentContainerStyle={s.content} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag"
      refreshControl={session && !local && !paused && (screen === 'home' || screen === 'group') ? <RefreshControl refreshing={busy} tintColor={colors.accent} onRefresh={() => launch(() => sync())} /> : undefined}>
      {!!notice && <Text accessibilityLiveRegion="polite" style={ui.notice}>{notice}</Text>}
      {screen === 'home' && (tab === 'Groups' || tab === 'Friends') && <>
        {session ? <SegmentedButtons value={local ? 'phone' : 'shared'} onValueChange={value => { if ((value === 'phone') !== local) changeScope(session, value === 'phone'); }} buttons={[{ value: 'phone', label: 'On this phone', disabled: busy }, { value: 'shared', label: 'Shared', disabled: busy }]} /> : <Text style={ui.caption}>Saved on this phone. No account needed.</Text>}
        {!visibleGroups.length && <View style={s.empty}><View style={s.emptyIcon}><Icon name={direct ? 'people' : 'groups'} size={34} /></View><Text style={ui.section}>{direct ? 'Share a bill with someone' : 'Who are you sharing with?'}</Text><Text style={ui.caption}>{direct ? 'Keep bills with one person here.' : 'Make a group for a trip, your home or dinner.'}</Text></View>}
        {!!visibleGroups.length && <View style={s.groupList}>{visibleGroups.map(row => { const me = row.group.participants.find(person => !local && session ? String(person.user_id) === session.userId : person.id === row.group.participants[0]?.id); return <Pressable key={row.group.id} accessibilityRole="button" disabled={busy} style={s.groupRow} onPress={() => launch(() => openGroup(row))}><View style={s.groupMark}>{direct ? <Avatar name={row.group.name} /> : <Icon name="groups" size={24} />}</View><View style={ui.rowBody}><Text style={ui.rowTitle}>{row.group.name}{row.group.archived ? ' (archived)' : ''}</Text><Text style={ui.rowSub}>{me ? position('You', row.group.balances[me.id] ?? '0') : 'See who owes whom'}</Text>{commands.some(value => value.group_id === row.group.id) && <Text style={s.pending}>Waiting to sync</Text>}</View><Icon name="next" size={18} color={colors.muted} /></Pressable>; })}</View>}
        <Button title={direct ? 'Add a person' : 'New group'} icon="add" kind={!visibleGroups.length ? 'primary' : 'secondary'} disabled={busy} onPress={() => { setGroupName(''); setPeople(['']); navigate('create'); }} />
        {direct && !!groupPeople.length && <Text style={ui.section}>People in your groups</Text>}
        {direct && groupPeople.map(({ row, person }) => <Pressable key={`${row.group.id}|${person.id}`} accessibilityRole="button" disabled={busy} style={ui.row} onPress={() => launch(() => openGroup(row))}><Avatar name={person.name} /><View style={ui.rowBody}><Text style={ui.rowTitle}>{person.name}</Text><Text style={ui.rowSub}>{row.group.name}</Text></View><Icon name="next" size={18} color={colors.muted} /></Pressable>)}
      </>}
      {screen === 'create' && <><Text style={ui.caption}>{direct ? 'Keep your shared bills with this person.' : 'Add names now. Invite people later if you want to share.'}</Text>{!direct && <Input label="Group name" value={groupName} onChange={setGroupName} />}<Input label="Your name" value={myName} onChange={setMyName} />
        {people.map((name, index) => <View key={index} style={s.field}><Input label={direct ? 'Their name' : `Person ${index + 2}`} value={name} onChange={value => setPeople(rows => rows.map((row, at) => at === index ? value : row))} />{!direct && people.length > 1 && <Button title={`Remove person ${index + 2}`} kind="text" disabled={busy} onPress={() => setPeople(rows => rows.filter((_, at) => at !== index))} />}</View>)}
        {!direct && <Button title="Add another person" kind="text" icon="add" onPress={() => setPeople(rows => [...rows, ''])} />}
        <Button title={direct ? 'Add person' : 'Create group'} kind="primary" disabled={busy} onPress={() => launch(async () => {
          const participants = [myName, ...people].map(name => ({ id: uuid(), name: name.trim() }));
          if (!participants.every(person => person.name)) throw new Error('Enter a name for each person.');
          if (!local && session) Object.assign(participants[0], { user_id: Number(session.userId) });
          const group = { ...emptyGroup(uuid(), direct ? people[0].trim() : groupName, participants), is_direct: direct };
          const db = await getDatabase();
          if (local) await localSave(group, 'group_created', { name: group.name });
          else {
            const id = uuid(), create: Command = { command_id: id, group_id: group.id, method: 'POST', path: '/groups', body: { command_id: id, id: group.id, name: group.name, participants: participants.map(({ id, name }) => ({ id, name })), self_participant_id: participants[0].id, is_direct: direct }, state: 'pending', error: null };
            await publishLocal(db, owner, group, [create]);
            if (session && !paused) { try { await syncOutbox(db, session); } catch (error) { setNotice(`Saved on this phone. ${error instanceof Error ? error.message : 'Retry sync.'}`); } }
          }
          setGroupId(group.id); setExpenseId(null); setDraft(null); setScreen('group');
        })} />
      </>}
      {screen === 'group' && selected && preview && <>{!!previewError && <Text>{previewError}</Text>}<GroupScreen key={`${owner}|${groupId}`} group={preview} accepted={selected.group} pending={pending} busy={busy} local={local} selfId={selfId} onConfirmReceipt={attempt => Alert.alert('Confirm receipt?', `Check your bank app for ${formatMoney(attempt.recorded_amount ?? attempt.amount)}. This acknowledges a record; it does not verify the bank transfer.`, [{ text: 'Cancel', style: 'cancel' }, { text: 'Received', onPress: () => { void groupAction(`/payment-attempts/${attempt.id}/confirm`, {}).catch(() => {}); } }])} onAdd={() => launch(() => openExpense())} onExpense={value => { setExpenseId(value.id); navigate('expenseDetail'); }} onSettle={value => { setTransfer(value); navigate('settle'); }} onReverse={value => confirm('Reverse payment record?', 'This restores balances in MeroSplit. It does not reverse a bank transfer.', () => reversePayment(value))} onSettings={() => navigate('members')} onSync={() => launch(() => sync())} onReview={value => launch(async () => { if (!session || local || paused) throw new Error('Connect and turn on sync to review the latest records.'); await saveGroup(await getDatabase(), owner, await request<Group>(session, `/groups/${groupId}`), 'shared'); setReviewCommand(value); navigate('review'); })} onDiscard={value => value.path === '/groups' ? confirm('Discard unsent group?', 'This removes the group and its unsent expenses and drafts from this phone. An already synced group may reappear when you sync.', async () => { await discardUnsentGroup(await getDatabase(), owner, value.group_id); setGroupId(null); navigate('home'); }) : confirm('Discard unsent change?', 'Accepted records remain. Sync first if a previous request may already have reached the server.', async () => { await discardCommand(await getDatabase(), owner, value.command_id); })} /></>}
      {screen === 'expenseDetail' && selected && expense && <ExpenseDetail expense={expense} group={selected.group} busy={busy} canEdit={!pending.length && !selected.group.archived} onEdit={() => launch(() => openExpense(expense))} onDelete={() => confirm('Delete expense?', 'Balances will update. You can restore this expense later.', () => changeExpense(expense))} onRestore={() => confirm('Restore expense?', 'Its original split will be added to balances once.', () => changeExpense(expense, true))} />}
      {screen === 'expense' && selected && <ExpenseForm key={`${owner}|${groupId}|${expenseId ?? 'new'}`} group={selected.group} expense={reviewInput ?? (expenseId ? selected.group.expenses.find(value => value.id === expenseId) : undefined)} selfId={selfId} busy={busy} initialDraft={draft ?? undefined} onDraftChange={value => { const scope = owner, id = groupId!; draftWrites.current = draftWrites.current.then(async () => saveDraft(await getDatabase(), scope, id, value)).catch(error => setNotice(`Could not save draft: ${error.message}`)); }} onSave={saveExpense} onCancel={back} />}
      {screen === 'review' && selected && reviewCommand && <SavedChangeScreen command={reviewCommand} group={selected.group} busy={busy} onDiscard={() => confirm('Discard this unsent change?', 'Accepted records remain. Your saved change will be removed from this phone.', async () => { await discardCommand(await getDatabase(), owner, reviewCommand.command_id); setReviewCommand(null); navigate('group'); })} onEditSaved={value => { setReviewInput(value); setDraft(null); setExpenseId(reviewCommand.method === 'PUT' ? value.id : null); navigate('expense'); }} />}
      {screen === 'settle' && selected && preview && <SettleForm key={`${owner}|${groupId}`} group={preview} initial={transfer} busy={busy} onSave={savePayment} onCancel={back} />}
      {screen === 'members' && selected && <MembersScreen key={`${owner}|${groupId}`} group={selected.group} selfId={selfId} local={local} busy={busy} onAction={groupAction} onLocalAdd={name => perform(async () => { const person = { id: uuid(), name: name.trim() }; if (!person.name || person.name.length > 120) throw new Error('Enter a name up to 120 characters.'); if (selected.group.is_direct) throw new Error('A friend ledger has two people.'); await localSave(recalculateLocal({ ...selected.group, version: selected.group.version + 1, participants: [...selected.group.participants, person] }), 'participant_added', { name: person.name }); })} onExport={exportGroup} onPublish={local && session ? () => perform(async () => {
        const db = await getDatabase(), group = selected.group, id = uuid();
        const queue: Command[] = [{ command_id: id, group_id: group.id, method: 'POST', path: '/groups', body: { command_id: id, id: group.id, name: group.name, is_direct: !!group.is_direct, participants: group.participants.map(({ id, name }) => ({ id, name })), self_participant_id: selfId }, state: 'pending', error: null }];
        for (const value of group.expenses.filter(value => !value.deleted)) { const id = uuid(); queue.push({ command_id: id, group_id: group.id, method: 'POST', path: `/groups/${group.id}/expenses`, body: { command_id: id, ...expensePayload(value) }, state: 'pending', error: null }); }
        for (const value of group.settlements.filter(value => !value.reversed)) { const id = uuid(); queue.push({ command_id: id, group_id: group.id, method: 'POST', path: `/groups/${group.id}/settlements`, body: { command_id: id, id: value.id, sender: value.sender, recipient: value.recipient, amount: value.amount }, state: 'pending', error: null }); }
        await publishLocal(db, accountOwner(session), group, queue); changeScope(session, false); if (!paused) { await syncOutbox(db, session); await load(accountOwner(session)); } setNotice('Account copy saved. The original remains on this phone.');
      }) : undefined} />}
      {screen === 'activity' && <>
        {!groups.some(row => row.group.activity.length || row.group.expenses.length) && <Text style={ui.caption}>No changes yet. Add a bill to get started.</Text>}
        {groups.flatMap(row => row.group.activity.map((raw, index) => ({ row, value: raw as { kind: string; data: { id?: string; description?: string }; created_at?: string }, index }))).sort((a, b) => (b.value.created_at ?? '').localeCompare(a.value.created_at ?? '')).map(({ row, value, index }) => { const record = row.group.expenses.find(expense => expense.id === value.data?.id); const labels: Record<string, string> = { expense_saved: 'Expense saved', manual_settlement: 'Payment recorded', opening_proposed: 'Opening balances proposed', opening_acknowledged: 'Opening balances acknowledged', expense_added: 'Expense added', expense_updated: 'Expense edited', expense_deleted: 'Expense deleted', expense_restored: 'Expense restored', settlement_recorded: 'Payment recorded', settlement_reversed: 'Payment record reversed', group_created: 'Group created', participant_added: 'Member added', opening_balance_proposed: 'Opening balances proposed', opening_balance_acknowledged: 'Opening balances acknowledged' }; return <Pressable accessibilityRole="button" key={`${row.group.id}|${index}`} style={s.row} onPress={() => launch(async () => { await openGroup(row); if (record) { setExpenseId(record.id); setScreen('expenseDetail'); } })}><Text style={s.heading}>{labels[value.kind] ?? value.kind.replaceAll('_', ' ')}</Text><Text>{row.group.name}{record ? ` · ${record.description}` : ''}</Text>{value.created_at && <Text>{new Date(value.created_at).toLocaleString()}</Text>}</Pressable>; })}
        {groups.filter(row => !row.group.activity.length).flatMap(row => row.group.expenses.map(value => <Pressable accessibilityRole="button" key={`${row.group.id}|${value.id}`} style={s.row} onPress={() => launch(async () => { await openGroup(row); setExpenseId(value.id); setScreen('expenseDetail'); })}><Text>{value.description}{value.deleted ? ' (deleted)' : ''} · {row.group.name}</Text><Text>{value.date} · {formatMoney(value.total)}</Text></Pressable>))}
      </>}
      {screen === 'login' && <><Text style={ui.caption}>Sign in to share groups with other people.</Text><Input label="Email" value={email} onChange={setEmail} /><Input label="Password" value={password} onChange={setPassword} secret /><Button title={signup ? 'Create account' : 'Sign in'} kind="primary" disabled={busy} onPress={() => launch(async () => { const value = await authenticate(API_URL, email, password, signup); await saveSession(value); changeScope(value, false); setPassword(''); setMyName(value.email.split('@')[0]); if (!paused) { try { await syncAccount(value); } catch { setNotice('Signed in. Saved bills are available. Try sync again when connected.'); } } })} /><Button title={signup ? 'I already have an account' : 'Create an account'} kind="text" disabled={busy} onPress={() => { setNotice(''); setSignup(value => !value); }} /><Text style={ui.caption}>Email checks and password recovery are not available in this pilot.</Text></>}
      {screen === 'home' && tab === 'Account' && <>
        <View style={s.profile}><Avatar name={myName} /><View style={ui.rowBody}><Text style={ui.section}>{myName}</Text><Text style={ui.caption}>{session?.email ?? 'Using this phone without an account'}</Text></View></View>
        {!session && <Button title="Sign in to share groups" kind="primary" onPress={() => { setSignup(false); navigate('login'); }} />}
        <View style={s.groupList}>
          {session && <><Pressable accessibilityRole="button" disabled={busy || paused} style={s.groupRow} onPress={() => launch(async () => { const me = await request<{ payment_profile: { vpa: string } | null }>(session, '/me'); setVpa(me.payment_profile?.vpa ?? ''); navigate('profile'); })}><Icon name="pay" /><View style={ui.rowBody}><Text style={ui.rowTitle}>Your UPI address</Text><Text style={ui.caption}>{paused ? 'Turn on sync to load it' : 'For people paying you back'}</Text></View><Icon name="next" size={18} /></Pressable>
          <Pressable accessibilityRole="button" disabled={busy} style={s.groupRow} onPress={() => navigate('sync')}><Icon name="check" /><View style={ui.rowBody}><Text style={ui.rowTitle}>Sync settings</Text><Text style={ui.caption}>{paused ? 'Paused' : `${commands.length} saved ${commands.length === 1 ? 'change' : 'changes'} waiting`}</Text></View><Icon name="next" size={18} /></Pressable></>}
          <Pressable accessibilityRole="button" style={s.groupRow} onPress={() => navigate('activity')}><Icon name="history" /><View style={ui.rowBody}><Text style={ui.rowTitle}>History</Text><Text style={ui.caption}>Bills, edits and payments</Text></View><Icon name="next" size={18} /></Pressable>
          <Pressable accessibilityRole="button" style={s.groupRow} onPress={() => navigate('data')}><Icon name="settings" /><View style={ui.rowBody}><Text style={ui.rowTitle}>Your data</Text><Text style={ui.caption}>Export and account options</Text></View><Icon name="next" size={18} /></Pressable>
        </View>
        <Text style={ui.caption}>MeroSplit 0.3.0 · Indian rupees</Text>
      </>}
      {screen === 'profile' && session && <>
        <Input label="Your UPI address" value={vpa} onChange={setVpa} /><Text style={ui.caption}>People can use this to pay you. Check it carefully. It is entered by you and is not bank verified.</Text><Button title="Save UPI address" kind="primary" disabled={busy || paused} onPress={() => launch(async () => { await request(session, '/me/payment-profile', 'PUT', { vpa }); setNotice('UPI address saved.'); })} />
      </>}
      {screen === 'sync' && session && <>
        <Text style={ui.section}>{paused ? 'Sync is paused' : 'Sync is on'}</Text><Text style={ui.caption}>{local ? 'Groups on this phone stay private. Open Shared groups to sync with your account.' : 'Shared groups refresh when you open the app or return to it. Pull down on a group to refresh.'}</Text>
        {!!commands.length && <Text style={ui.notice}>{commands.length} saved {commands.length === 1 ? 'change is' : 'changes are'} waiting to sync.</Text>}
        <View style={ui.row}><View style={ui.rowBody}><Text style={ui.rowTitle}>Sync shared groups</Text><Text style={ui.caption}>{paused ? 'Paused' : 'On'}</Text></View><Switch accessibilityLabel="Sync shared groups" value={!paused} disabled={busy || local} onValueChange={enabled => launch(async () => { await saveSyncPaused(!enabled); setPaused(!enabled); if (enabled) await syncAccount(session); })} /></View>
        {!local && !paused && <Button title="Try sync again" disabled={busy} onPress={() => launch(() => sync())} />}
      </>}
      {screen === 'data' && <>
        <Text style={ui.caption}>For a group's bills, open that group's settings and choose Export.</Text>
        {session && <>
          <Button title="Export account" disabled={busy || paused} onPress={() => launch(async () => { await shareJson('merosplit-account', await request(session, '/account/export')); })} />
          <Disclosure title="Account options"><Button title="Switch account" disabled={busy} kind="text" onPress={() => { setSignup(false); navigate('login'); }} />
          <Button title="Sign out" disabled={busy} onPress={() => confirm('Sign out?', 'Account records and unsent account changes will be removed from this phone. Groups stored only on this phone remain. Synced records stay in your account.', async () => { await draftWrites.current; const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15_000); try { const response = await fetch(`${session.baseUrl}/_allauth/app/v1/auth/session`, { method: 'DELETE', headers: { 'X-Session-Token': session.token }, signal: controller.signal }).catch(() => { throw new Error('Could not connect to sign out. Your records remain on this phone. Try again when online.'); }); if (!response.ok && response.status !== 401) throw new Error('Could not sign out. Try again.'); } finally { clearTimeout(timer); } await wipeAccount(await getDatabase(), accountOwner(session)); await saveSession(null); changeScope(null, true); })} />
          <Button title="Delete account" kind="danger" disabled={busy || paused} onPress={() => confirm('Delete account?', 'Export first. Sign-in and personal details will be removed. Shared history remains anonymized for other people. Unsent account changes are removed from this phone.', async () => { await request(session, '/account', 'DELETE'); await draftWrites.current; await wipeAccount(await getDatabase(), accountOwner(session)); await saveSession(null); changeScope(null, true); })} /></Disclosure>
        </>}
      </>}
    </ScrollView>
    {screen === 'home' && <View style={s.tabs}>{([{ value: 'Groups', label: 'Groups', icon: 'groups' }, { value: 'Friends', label: 'People', icon: 'people' }, { value: 'Account', label: 'Me', icon: 'me' }] as const).map(item => <Pressable accessibilityRole="tab" accessibilityState={{ selected: tab === item.value, disabled: busy }} disabled={busy} key={item.value} style={[s.tab, tab === item.value && s.selectedTab]} onPress={() => { setTab(item.value); setNotice(''); }}><Icon name={item.icon} color={tab === item.value ? colors.accent : colors.muted} /><Text style={[s.tabText, tab === item.value && { color: colors.accent }]}>{item.label}</Text></Pressable>)}</View>}
  </KeyboardAvoidingView></SafeAreaView>;
}
export default function App() { return <SafeAreaProvider><UIProvider><AppContent /></UIProvider></SafeAreaProvider>; }
const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background }, loading: { alignItems: 'center', justifyContent: 'center', gap: 14 },
  content: { padding: 20, gap: 18, paddingBottom: 36 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 72, paddingHorizontal: 16, paddingTop: 4, paddingBottom: 8 },
  title: { flex: 1, flexShrink: 1, fontSize: 28, lineHeight: 34, fontWeight: '600', color: colors.text },
  heading: ui.section, field: { gap: 7 }, row: { gap: 6, paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  groupList: { backgroundColor: colors.surface, borderRadius: 20, paddingHorizontal: 16 },
  groupRow: { minHeight: 82, flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  groupMark: { width: 46, height: 46, borderRadius: 16, backgroundColor: colors.soft, alignItems: 'center', justifyContent: 'center' },
  pending: { fontSize: 13, color: colors.accent },
  empty: { paddingVertical: 28, gap: 12 }, emptyIcon: { width: 70, height: 70, borderRadius: 24, backgroundColor: colors.soft, alignItems: 'center', justifyContent: 'center', marginBottom: 6 },
  profile: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 8 },
  tabs: { flexDirection: 'row', backgroundColor: colors.surface, marginHorizontal: 16, marginBottom: 8, borderRadius: 24, padding: 6, gap: 4 },
  tab: { flex: 1, minHeight: 58, alignItems: 'center', justifyContent: 'center', gap: 4, borderRadius: 18, paddingVertical: 8 },
  tabText: { fontSize: 13, fontWeight: '500', color: colors.muted }, selectedTab: { backgroundColor: colors.soft },
});
