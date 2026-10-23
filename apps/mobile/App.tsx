import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, AppState, BackHandler, KeyboardAvoidingView, Linking, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import * as Crypto from 'expo-crypto';
import { accountOwner, ApiError, authenticate, claimLegacyGroup, expensePayload, request, syncOutbox } from './src/api';
import { formatMoney } from './src/accounting';
import { emptyGroup, previewPending } from './src/ledger';
import { getDatabase, savedSession, saveSession, retireSyncPause, shareJson, shareText } from './src/native';
import { discardCommand, discardUnsentGroup, enqueue, listGroups, pendingCommands, createPendingGroup, listLegacyGroups, listLegacyRecoveries, listUnavailableGroups, reconcileGroupCache, readDraft, replaceCommand, saveDraft, saveGroup, wipeAccount } from './src/storage';
import GroupScreen, { ExpenseDetail, position } from './src/GroupScreen';
import ExpenseForm from './src/ExpenseForm';
import type { ExpenseFormDraft } from './src/ExpenseForm';
import SettleForm from './src/SettleForm';
import MembersScreen from './src/MembersScreen';
import SavedChangeScreen from './src/SavedChangeScreen';
import SplitwiseImportScreen from './src/SplitwiseImportScreen';
import ProfilePhoto from './src/ProfilePhoto';
import PushSettings, { usePushNotifications } from './src/PushSettings';
import type { PushTarget } from './src/notifications';
import BillAttachments from './src/BillAttachments';
import { clearAccountMediaUploads, clearMediaPreviews } from './src/media';
import type { CachedGroup, Command, Expense, Group, LegacyRecovery, Session, Settlement } from './src/types';
import { Avatar, balanceColor, Button, Disclosure, Icon, UIProvider, radii, useUI, type Palette, type AppearancePreference } from './src/ui';
import { RadioButton, SegmentedButtons, Text } from 'react-native-paper';

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? (Platform.OS === 'android' ? 'http://10.0.2.2:8000' : 'http://localhost:8000');
const uuid = () => Crypto.randomUUID();
type Screen = 'home' | 'create' | 'group' | 'expense' | 'expenseDetail' | 'settle' | 'members' | 'login' | 'review' | 'activity' | 'profile' | 'appearance' | 'data' | 'import' | 'notifications';
type Transfer = { sender: string; recipient: string; amount: string };
function Input({ label, value, onChange, secret = false }: { label: string; value: string; onChange: (value: string) => void; secret?: boolean }) {
  const { ui, inputColors } = useUI();
  return <View style={{ gap: 6 }}><Text style={ui.label}>{label}</Text><TextInput {...inputColors} accessibilityLabel={label} style={ui.input} value={value} onChangeText={onChange} secureTextEntry={secret} autoCorrect={false} autoCapitalize={secret || label === 'Email' || label === 'Your UPI address' ? 'none' : 'words'} autoComplete={label === 'Email' ? 'email' : secret ? 'current-password' : 'off'} keyboardType={label === 'Email' ? 'email-address' : 'default'} /></View>;
}
function AppContent() {
  const { palette: colors, ui, inputColors, dark, appearance, changeAppearance } = useUI();
  const s = makeStyles(colors);
  const [session, setSession] = useState<Session | null>(null), [ready, setReady] = useState(false), [expired, setExpired] = useState(false);
  const [groups, setGroups] = useState<CachedGroup[]>([]), [commands, setCommands] = useState<Command[]>([]);
  const [screen, setScreen] = useState<Screen>('home'), [tab, setTab] = useState('Groups'), [groupId, setGroupId] = useState<string | null>(null);
  const [expenseId, setExpenseId] = useState<string | null>(null), [draft, setDraft] = useState<ExpenseFormDraft | null>(null), [transfer, setTransfer] = useState<Transfer | undefined>();
  const [reviewCommand, setReviewCommand] = useState<Command | null>(null), [reviewInput, setReviewInput] = useState<Expense | undefined>();
  const [busy, setBusy] = useState(false), [feedback, setFeedback] = useState({ text: '', tone: 'info' as 'info' | 'success' | 'warning' | 'error' });
  const notice = feedback.text;
  const setNotice = (text: string, tone: typeof feedback.tone = 'info') => setFeedback({ text, tone });
  const [email, setEmail] = useState(''), [password, setPassword] = useState(''), [signup, setSignup] = useState(false);
  const [groupName, setGroupName] = useState(''), [myName, setMyName] = useState('You'), [people, setPeople] = useState(['', '']);
  const [vpa, setVpa] = useState(''), [savedVpa, setSavedVpa] = useState('');
  const [legacy, setLegacy] = useState<Group[]>([]), [recoveries, setRecoveries] = useState<LegacyRecovery[]>([]), [unavailable, setUnavailable] = useState<Group[]>([]);
  const [legacySelf, setLegacySelf] = useState<Record<string, string>>({});
  const owner = session ? accountOwner(session) : '', ownerRef = useRef(owner); ownerRef.current = owner;
  const lock = useRef(false), draftWrites = useRef(Promise.resolve()), activeSessionRef = useRef(session); activeSessionRef.current = session;
  const [pushTarget, setPushTarget] = useState<{ token: string; target: PushTarget | null } | null>(null);
  const push = usePushNotifications(session, {
    onOpen: async target => { if (session) setPushTarget({ token: session.token, target }); },
    onForeground: async () => { if (ready && session && !lock.current) launch(() => sync()); },
  });
  const activeGroupRef = useRef(groupId); activeGroupRef.current = groupId;
  const selected = groups.find(row => row.group.id === groupId) ?? null;
  const pending = commands.filter(command => command.group_id === groupId);
  const selfId = selected?.group.participants.find(person => session && !person.removed && String(person.user_id) === session.userId)?.id ?? '';
  let preview = selected?.group ?? null, previewError = '';
  if (preview && pending.length) { try { preview = previewPending(preview, pending); } catch (error) { previewError = error instanceof Error ? error.message : 'Sync to review saved changes.'; } }
  const expense = preview?.expenses.find(value => value.id === expenseId);
  function navigate(value: Screen) { setNotice(''); setScreen(value); }
  function changeScope(value: Session | null) {
    ownerRef.current = value ? accountOwner(value) : '';
    setSession(value); setExpired(false); setGroups([]); setCommands([]); setLegacy([]); setRecoveries([]); setUnavailable([]); setLegacySelf({});
    setGroupId(null); setExpenseId(null); setDraft(null); setVpa(''); setSavedVpa(''); setScreen(value ? 'home' : 'login'); setTab('Groups');
    setReviewCommand(null); setReviewInput(undefined);
    void load(ownerRef.current).catch(error => setNotice(error.message, 'error'));
  }
  async function load(scope = ownerRef.current) {
    if (!scope) return;
    const db = await getDatabase();
    const [rows, queue, older, backups, hidden] = await Promise.all([listGroups(db, scope), pendingCommands(db, scope), listLegacyGroups(db), listLegacyRecoveries(db, scope), listUnavailableGroups(db, scope)]);
    if (ownerRef.current === scope) { setGroups(rows); setCommands(queue); setLegacy(older); setRecoveries(backups); setUnavailable(hidden); }
  }
  async function perform<T,>(action: () => Promise<T>): Promise<T> {
    if (lock.current) throw new Error('Please wait for the current action.');
    lock.current = true; setBusy(true); setNotice('');
    try { return await action(); }
    catch (error) { if (error instanceof ApiError && error.status === 401) setExpired(true); setNotice(error instanceof ApiError && error.status === 401 ? 'Sign in again to continue. Your saved changes are safe.' : error instanceof Error ? error.message : 'Could not save. Please try again.', 'error'); throw error; }
    finally { await load().catch(() => {}); lock.current = false; setBusy(false); }
  }
  const launch = (action: () => Promise<unknown>) => { void perform(action).catch(() => {}); };
  function confirm(title: string, message: string, action: () => Promise<unknown>) {
    Alert.alert(title, message, [{ text: 'Cancel', style: 'cancel' }, { text: 'Confirm', onPress: () => launch(action) }]);
  }
  async function syncAccount(active: Session) {
    const db = await getDatabase(), scope = accountOwner(active);
    let writeError: unknown;
    try { await syncOutbox(db, active); } catch (error) { if (error instanceof ApiError && error.status === 401) throw error; writeError = error; }
    const rows = await request<{ groups: { id: string }[] }>(active, '/groups'), snapshots: Group[] = [];
    for (const row of rows.groups) snapshots.push(await request<Group>(active, `/groups/${row.id}`));
    const removed = await reconcileGroupCache(db, scope, snapshots);
    await load(scope);
    if (ownerRef.current !== scope) return;
    if (activeGroupRef.current && removed.includes(activeGroupRef.current)) { setGroupId(null); setScreen('home'); setNotice('You no longer have access to that group.', 'warning'); }
    if (writeError) throw writeError;
  }
  async function sync() {
    if (!session) throw new Error('Sign in to continue.');
    await syncAccount(session);
  }
  useEffect(() => { void Promise.all([savedSession(), retireSyncPause()]).then(([value]) => { changeScope(value); if (value) { setEmail(value.email); setMyName(value.email.split('@')[0]); } }).catch(() => { setScreen('login'); setNotice('Could not restore sign-in. Your saved records remain on this phone.', 'error'); }).finally(() => setReady(true)); }, []);
  useEffect(() => { if (ready && owner) void load().catch(error => setNotice(error.message, 'error')); }, [owner, ready]);
  useEffect(() => {
    if (!ready || !session || expired) return;
    if (!lock.current) launch(() => sync());
    const listener = AppState.addEventListener('change', state => { if (state === 'active' && !lock.current) launch(() => sync()); });
    return () => listener.remove();
  }, [owner, ready, expired, session?.token]);
  useEffect(() => {
    if (!ready || busy || !pushTarget) return;
    setPushTarget(null);
    if (!session || pushTarget.token !== session.token) return;
    const active = session, scope = accountOwner(active);
    launch(async () => {
      await draftWrites.current;
      let target = pushTarget.target;
      if (target) {
        try {
          const group = await request<Group>(active, `/groups/${target.group.id}`);
          target = { group, expenseId: group.expenses.some(value => value.id === target?.expenseId && !value.deleted) ? target.expenseId : null };
        } catch { target = null; }
      }
      if (target) await saveGroup(await getDatabase(), scope, target.group, 'shared');
      if (activeSessionRef.current?.token !== active.token) return;
      changeScope(active); setTab('Groups');
      if (target) {
        setGroups([{ kind: 'shared', group: target.group }]); setGroupId(target.group.id);
        setExpenseId(target.expenseId); setScreen(target.expenseId ? 'expenseDetail' : 'group');
      } else setNotice('This bill is no longer available. Your groups are still here.');
    });
  }, [ready, busy, pushTarget, session?.token]);
  async function endPushSession(active: Session) {
    await push.disable().catch(() => {});
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(`${active.baseUrl}/_allauth/app/v1/auth/session`, { method: 'DELETE', headers: { 'X-Session-Token': active.token }, signal: controller.signal }).catch(() => { throw new Error('Could not connect to sign out. Your records remain on this phone. Try again when online.'); });
      if (!response.ok && response.status !== 401) throw new Error('Could not sign out. Try again.');
    } finally { clearTimeout(timer); }
    await push.clear(); setPushTarget(null);
  }
  function back() {
    if (screen === 'expense' || screen === 'expenseDetail' || screen === 'settle' || screen === 'members' || screen === 'review') navigate('group');
    else if (screen === 'import') navigate('data');
    else navigate(session ? 'home' : 'login');
  }
  useEffect(() => { const event = BackHandler.addEventListener('hardwareBackPress', () => { if (busy) return true; if (screen === 'home' || !session && screen === 'login') return false; back(); return true; }); return () => event.remove(); }, [screen, busy, !!session]);
  function command(method: Command['method'], path: string, body: Record<string, unknown>): Command {
    const id = uuid(); return { command_id: id, group_id: groupId!, method, path, body: { ...body, command_id: id }, state: 'pending', error: null };
  }
  async function queue(value: Command, replacing?: string) {
    if (replacing) await replaceCommand(await getDatabase(), owner, replacing, value);
    else await enqueue(await getDatabase(), owner, value);
    if (session) {
      try { await syncOutbox(await getDatabase(), session); return; }
      catch (error) { if (error instanceof ApiError && error.status === 401) setExpired(true); setNotice('Pending sync. Your change is saved.', 'warning'); return; }
    }
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
      await queue(command(expenseId ? 'PUT' : 'POST', `/groups/${groupId}/expenses${expenseId ? `/${value.id}` : ''}`, expensePayload(value, !!expenseId)), reviewCommand?.command_id);
      await draftWrites.current; await saveDraft(await getDatabase(), owner, groupId!, null); setDraft(null); setReviewCommand(null); setReviewInput(undefined); navigate('group');
    });
  }
  async function changeExpense(value: Expense, restore = false) {
    if (!selected) return;
    if (selected.group.archived) throw new Error('Reopen this group in settings before making changes.');
    await queue(command(restore ? 'POST' : 'DELETE', `/groups/${groupId}/expenses/${value.id}${restore ? '/restore' : ''}`, { version: value.version }));
    navigate('group');
  }
  async function savePayment(value: Transfer) {
    await perform(async () => {
      if (!selected) throw new Error('Open a group first.');
      if (selected.group.archived) throw new Error('Reopen this group in settings before making changes.');
      const paymentId = uuid(), now = new Date();
      const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      const attempt = selected.group.payment_attempts?.find(attempt => attempt.sender === value.sender && attempt.recipient === value.recipient && ['prepared', 'reported'].includes(attempt.state) && !pending.some(command => command.path.endsWith('/settlements') && command.body.attempt_id === attempt.id));
      await queue(command('POST', `/groups/${groupId}/settlements`, { id: paymentId, ...value, date, ...(attempt ? { attempt_id: attempt.id } : {}) }));
      navigate('group');
    });
  }
  async function reversePayment(value: Settlement) {
    if (!selected) return;
    if (selected.group.archived) throw new Error('Reopen this group in settings before making changes.');
    await queue(command('POST', `/groups/${groupId}/settlements/${value.id}/reverse`, {}));
  }
  async function groupAction(suffix: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return perform(async () => {
      if (!session) throw new Error('Sign in to continue.');
      if (pending.length) throw new Error('Review pending changes first.');
      await enqueue(await getDatabase(), owner, command('POST', `/groups/${groupId}${suffix}`, body));
      const receipts = await syncOutbox(await getDatabase(), session); return receipts.at(-1) ?? {};
    });
  }
  async function exportGroup(format: 'json' | 'csv') {
    await perform(async () => {
      if (!selected || !session) return;
      if (format === 'csv') await shareText('merosplit-group.csv', await request<string>(session, `/groups/${groupId}/export?format=csv`, 'GET', undefined, 'text'), 'text/csv');
      else await shareJson('merosplit-group', await request(session, `/groups/${groupId}/export?format=json`));
    });
  }
  async function exportSaved() {
    const db = await getDatabase();
    const drafts = await db.getAllAsync<{ group_id: string; body: string }>('SELECT group_id,body FROM drafts WHERE owner=?', owner);
    await shareJson('merosplit-saved-changes', { groups, unavailable_groups: unavailable, pending_commands: commands, drafts: drafts.map(row => ({ id: row.group_id, data: JSON.parse(row.body) })) });
  }
  const direct = tab === 'Friends';
  const visibleGroups = groups.filter(row => !!row.group.is_direct === direct);
  const title = screen === 'home' ? (tab === 'Friends' ? 'People' : tab === 'Account' ? 'Me' : tab) : screen === 'login' ? (signup ? 'Create account' : 'Sign in') : screen === 'create' ? (direct ? 'Add a person' : 'New group') : screen === 'expense' ? (expenseId ? 'Edit bill' : 'Add a bill') : screen === 'expenseDetail' ? expense?.description ?? 'Bill' : screen === 'settle' ? 'Record a payment' : screen === 'members' ? 'Group settings' : screen === 'review' ? 'Review your bill' : screen === 'activity' ? 'History' : screen === 'profile' ? 'Profile' : screen === 'notifications' ? 'Notifications' : screen === 'appearance' ? 'Appearance' : screen === 'data' ? 'Data' : screen === 'import' ? 'Import from Splitwise' : selected?.group.name ?? 'Group';
  if (!ready) return <SafeAreaView style={[s.screen, s.loading]}><ActivityIndicator color={colors.accent} /><Text style={ui.caption}>Opening your groups…</Text></SafeAreaView>;
  return <SafeAreaView style={s.screen} edges={['top', 'bottom']}><StatusBar style={dark ? 'light' : 'dark'} /><KeyboardAvoidingView style={s.screen} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
    <View style={s.header}>{screen !== 'home' && (session || screen !== 'login') && <Button title={screen === 'expense' || screen === 'settle' || screen === 'create' ? 'Cancel' : 'Back'} kind="text" icon="back" disabled={busy} onPress={back} />}<Text style={s.title}>{title}</Text>{screen === 'group' && selected && <Pressable accessibilityRole="button" accessibilityLabel="Group settings" disabled={busy} style={{ minWidth: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center' }} onPress={() => navigate('members')}><Icon name="settings" /></Pressable>}{busy && <ActivityIndicator accessibilityLabel="Working" color={colors.accent} />}</View>
    <ScrollView key={`${owner}|${screen}|${groupId ?? ''}`} contentContainerStyle={s.content} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag"
      refreshControl={session && !expired && (screen === 'home' || screen === 'group') ? <RefreshControl refreshing={busy} tintColor={colors.accent} colors={[colors.accent]} onRefresh={() => launch(() => sync())} /> : undefined}>
      {!!notice && <Text accessibilityLiveRegion="polite" accessibilityRole={feedback.tone === 'error' ? 'alert' : undefined} style={[ui.notice, feedback.tone === 'success' ? ui.success : feedback.tone === 'warning' ? ui.warning : feedback.tone === 'error' ? ui.error : undefined]}>{notice}</Text>}
      {expired && screen !== 'login' && <Button title="Sign in again" kind="primary" onPress={() => { setSignup(false); navigate('login'); }} />}
      {screen === 'home' && (tab === 'Groups' || tab === 'Friends') && <>
        {!visibleGroups.length && <Text style={ui.caption}>{direct ? 'No people yet' : 'No groups yet'}</Text>}
        {!!visibleGroups.length && <View style={s.groupList}>{visibleGroups.map(row => {
          const me = row.group.participants.find(person => session && String(person.user_id) === session.userId);
          const waiting = commands.filter(value => value.group_id === row.group.id), attention = waiting.some(value => value.state !== 'pending');
          return <Pressable key={row.group.id} accessibilityRole="button" disabled={busy} style={s.groupRow} onPress={() => launch(() => openGroup(row))}><View style={s.groupMark}>{direct ? <Avatar name={row.group.name} /> : <Icon name="groups" size={24} />}</View><View style={ui.rowBody}><Text style={ui.rowTitle}>{row.group.name}{row.group.archived ? ' · Archived' : ''}</Text><Text style={[ui.rowSub, me && { color: balanceColor(row.group.balances[me.id] ?? '0', colors) }]}>{me ? position('You', row.group.balances[me.id] ?? '0') : 'Pending sync'}</Text>{waiting.length > 0 && <Text style={s.pending}>{attention ? 'Needs review' : 'Pending sync'}</Text>}</View><Icon name="next" size={18} color={colors.muted} /></Pressable>;
        })}</View>}
        <Button title={direct ? 'Add person' : 'New group'} icon="add" kind={!visibleGroups.length ? 'primary' : 'secondary'} disabled={busy} onPress={() => { setGroupName(''); setPeople(['']); navigate('create'); }} />
        {!!legacy.length && <Button title="Recover earlier phone records" kind="text" onPress={() => navigate('data')} />}
        {!!unavailable.length && <Button title="Review unavailable groups" kind="text" onPress={() => navigate('data')} />}
      </>}
      {screen === 'create' && session && <>
        {!direct && <Input label="Group name" value={groupName} onChange={setGroupName} />}
        {people.map((name, index) => <View key={index} style={s.field}><Input label={direct ? 'Their name' : `Person ${index + 1}`} value={name} onChange={value => setPeople(rows => rows.map((row, at) => at === index ? value : row))} />{!direct && people.length > 1 && <Button title={`Remove person ${index + 1}`} kind="text" disabled={busy} onPress={() => setPeople(rows => rows.filter((_, at) => at !== index))} />}</View>)}
        {!direct && <Button title="Add person" kind="text" icon="add" disabled={busy} onPress={() => setPeople(rows => [...rows, ''])} />}
        <Button title={direct ? 'Add person' : 'Create group'} kind="primary" disabled={busy || people.some(name => !name.trim()) || !direct && !groupName.trim()} onPress={() => launch(async () => {
          const participants = [myName, ...people].map((name, index) => ({ id: uuid(), name: name.trim(), user_id: index === 0 ? Number(session.userId) : null }));
          const group = { ...emptyGroup(uuid(), direct ? people[0].trim() : groupName, participants), owner_id: Number(session.userId), is_direct: direct };
          const id = uuid(), create: Command = { command_id: id, group_id: group.id, method: 'POST', path: '/groups', body: { command_id: id, id: group.id, name: group.name, participants: participants.map(({ id, name }) => ({ id, name })), self_participant_id: participants[0].id, is_direct: direct }, state: 'pending', error: null };
          await createPendingGroup(await getDatabase(), owner, group, [create]);
          try { await syncOutbox(await getDatabase(), session); } catch (error) { if (error instanceof ApiError && error.status === 401) setExpired(true); setNotice('Pending sync. Your group is saved.', 'warning'); }
          setGroupId(group.id); setExpenseId(null); setDraft(null); setScreen('group');
        })} />
      </>}
      {screen === 'group' && selected && preview && <>{!!previewError && <Text>{previewError}</Text>}<GroupScreen key={`${owner}|${groupId}`} group={preview} accepted={selected.group} pending={pending} busy={busy} selfId={selfId} onConfirmReceipt={attempt => Alert.alert('Confirm receipt?', `Check your bank app for ${formatMoney(attempt.recorded_amount ?? attempt.amount)}. This acknowledges a record; it does not verify the bank transfer.`, [{ text: 'Cancel', style: 'cancel' }, { text: 'Received', onPress: () => { void groupAction(`/payment-attempts/${attempt.id}/confirm`, {}).catch(() => {}); } }])} onAdd={() => launch(() => openExpense())} onExpense={value => { setExpenseId(value.id); navigate('expenseDetail'); }} onSettle={value => { setTransfer(value); navigate('settle'); }} onReverse={value => confirm('Reverse payment record?', 'Balances will change. No bank transfer is reversed.', () => reversePayment(value))} onSync={() => launch(() => sync())} onReview={value => launch(async () => { if (!session) throw new Error('Sign in to continue.'); await saveGroup(await getDatabase(), owner, await request<Group>(session, `/groups/${groupId}`), 'shared'); setReviewCommand(value); navigate('review'); })} onDiscard={value => value.path === '/groups' ? confirm('Discard unsent group?', 'This removes unsent bills and drafts for this group. Already accepted records will return when connected.', async () => { await discardUnsentGroup(await getDatabase(), owner, value.group_id); setGroupId(null); navigate('home'); }) : confirm('Discard unsent change?', 'This removes your saved change. If it already reached the server, accepted records will remain.', async () => { await discardCommand(await getDatabase(), owner, value.command_id); })} /></>}
      {screen === 'expenseDetail' && selected && expense && <><ExpenseDetail expense={expense} group={selected.group} busy={busy} canEdit={!pending.length && !selected.group.archived} onEdit={() => launch(() => openExpense(expense))} onDelete={() => confirm('Delete expense?', 'Balances will update. You can restore this expense later.', () => changeExpense(expense))} onRestore={() => confirm('Restore expense?', 'Its original split will be added to balances once.', () => changeExpense(expense, true))} />
        {!expense.deleted && (!selected.group.expenses.some(value => value.id === expense.id) ? <Text style={ui.caption}>Pending sync</Text> : <BillAttachments key={`${owner}|${groupId}|${expense.id}`} session={session} groupId={selected.group.id} expenseId={expense.id} revision={selected.group.version} readOnly={selected.group.archived || !!pending.length} busy={busy}
          onBusyChange={value => { lock.current = value; setBusy(value); }} onChanged={async () => { if (!session) return; const scope = accountOwner(session); const updated = await request<Group>(session, `/groups/${selected.group.id}`); await saveGroup(await getDatabase(), scope, updated, 'shared'); await load(scope); }} />)}
      </>}
      {screen === 'expense' && selected && <ExpenseForm key={`${owner}|${groupId}|${expenseId ?? 'new'}`} group={selected.group} expense={reviewInput ?? (expenseId ? selected.group.expenses.find(value => value.id === expenseId) : undefined)} selfId={selfId} busy={busy} initialDraft={draft ?? undefined} onDraftChange={value => { const scope = owner, id = groupId!; draftWrites.current = draftWrites.current.then(async () => saveDraft(await getDatabase(), scope, id, value)).catch(error => setNotice(`Could not save draft: ${error.message}`, 'error')); }} onSave={saveExpense} onCancel={back} />}
      {screen === 'review' && selected && reviewCommand && <SavedChangeScreen command={reviewCommand} group={selected.group} busy={busy} onDiscard={() => confirm('Discard this unsent change?', 'Accepted records remain. Your saved change will be removed from this phone.', async () => { await discardCommand(await getDatabase(), owner, reviewCommand.command_id); setReviewCommand(null); navigate('group'); })} onEditSaved={value => { setReviewInput(value); setDraft(null); setExpenseId(reviewCommand.method === 'PUT' ? value.id : null); navigate('expense'); }} />}
      {screen === 'settle' && selected && preview && <SettleForm key={`${owner}|${groupId}`} group={preview} initial={transfer} busy={busy} onSave={savePayment} onCancel={back} />}
      {screen === 'members' && selected && <MembersScreen key={`${owner}|${groupId}`} group={selected.group} selfId={selfId} busy={busy} onAction={groupAction} onExport={exportGroup} />}
      {screen === 'activity' && <>
        {!groups.some(row => row.group.activity.length || row.group.expenses.length) && <Text style={ui.caption}>No changes yet. Add a bill to get started.</Text>}
        {groups.flatMap(row => row.group.activity.map((raw, index) => ({ row, value: raw as { kind: string; data: { id?: string; description?: string }; created_at?: string }, index }))).sort((a, b) => (b.value.created_at ?? '').localeCompare(a.value.created_at ?? '')).map(({ row, value, index }) => { const record = row.group.expenses.find(expense => expense.id === value.data?.id); const labels: Record<string, string> = { expense_saved: 'Expense saved', manual_settlement: 'Payment recorded', opening_proposed: 'Opening balances proposed', opening_acknowledged: 'Opening balances acknowledged', expense_added: 'Expense added', expense_updated: 'Expense edited', expense_deleted: 'Expense deleted', expense_restored: 'Expense restored', settlement_recorded: 'Payment recorded', settlement_reversed: 'Payment record reversed', group_created: 'Group created', participant_added: 'Member added', opening_balance_proposed: 'Opening balances proposed', opening_balance_acknowledged: 'Opening balances acknowledged' }; return <Pressable accessibilityRole="button" key={`${row.group.id}|${index}`} style={s.row} onPress={() => launch(async () => { await openGroup(row); if (record) { setExpenseId(record.id); setScreen('expenseDetail'); } })}><Text style={ui.section}>{labels[value.kind] ?? value.kind.replaceAll('_', ' ')}</Text><Text>{row.group.name}{record ? ` · ${record.description}` : ''}</Text>{value.created_at && <Text>{new Date(value.created_at).toLocaleString()}</Text>}</Pressable>; })}
        {groups.filter(row => !row.group.activity.length).flatMap(row => row.group.expenses.map(value => <Pressable accessibilityRole="button" key={`${row.group.id}|${value.id}`} style={s.row} onPress={() => launch(async () => { await openGroup(row); setExpenseId(value.id); setScreen('expenseDetail'); })}><Text>{value.description}{value.deleted ? ' (deleted)' : ''} · {row.group.name}</Text><Text>{value.date} · {formatMoney(value.total)}</Text></Pressable>))}
      </>}
      {screen === 'login' && <>
        <Input label="Email" value={email} onChange={setEmail} /><Input label="Password" value={password} onChange={setPassword} secret />
        <Button title={signup ? 'Create account' : 'Sign in'} kind="primary" disabled={busy || !email.trim() || !password} onPress={() => launch(async () => {
          await draftWrites.current;
          const value = await authenticate(API_URL, email, password, signup);
          if (session && session.token !== value.token) { await endPushSession(session); await clearMediaPreviews(); }
          await saveSession(value); changeScope(value); setPassword(''); setMyName(value.email.split('@')[0]); await syncAccount(value);
        })} />
        <Button title={signup ? 'I already have an account' : 'Create an account'} kind="text" disabled={busy} onPress={() => { setNotice(''); setSignup(value => !value); }} />
        <Text style={ui.caption}>Email checks and password recovery are not available in this beta.</Text>
        <Button title="Help" kind="text" onPress={() => launch(() => Linking.openURL(`${API_URL}/support`))} />
      </>}
      {screen === 'home' && tab === 'Account' && session && <>
        <Pressable accessibilityRole="button" accessibilityLabel="Profile" disabled={busy} style={s.profile} onPress={() => launch(async () => { navigate('profile'); const me = await request<{ payment_profile: { vpa: string } | null }>(session, '/me'); const value = me.payment_profile?.vpa ?? ''; setVpa(value); setSavedVpa(value); })}><Avatar name={myName} /><View style={ui.rowBody}><Text style={ui.section}>{myName}</Text><Text style={ui.caption}>{session.email}</Text></View><Icon name="next" size={18} /></Pressable>
        <View style={s.groupList}>
          {([{ route: 'notifications', title: 'Notifications', icon: 'history' }, { route: 'appearance', title: 'Appearance', icon: 'settings' }, { route: 'activity', title: 'History', icon: 'history' }, { route: 'data', title: 'Data', icon: 'settings' }] as const).map(item => <Pressable key={item.route} accessibilityRole="button" disabled={busy} style={s.groupRow} onPress={() => navigate(item.route)}><Icon name={item.icon} /><Text style={[ui.rowTitle, ui.rowBody]}>{item.title}</Text><Icon name="next" size={18} /></Pressable>)}
        </View>
      </>}
      {screen === 'import' && session && <SplitwiseImportScreen key={owner} session={session} busy={busy}
        onBusyChange={value => { lock.current = value; setBusy(value); }} onCancel={back}
        onImported={(group, alreadyImported) => { if (ownerRef.current !== accountOwner(session)) return; setGroups(rows => [...rows.filter(row => row.group.id !== group.id), { kind: 'shared', group }]); setGroupId(group.id); setExpenseId(null); setTab('Groups'); setScreen('group'); setNotice(alreadyImported ? 'Already imported.' : 'Imported.', 'success'); }} />}
      {screen === 'profile' && session && <>
        <ProfilePhoto key={owner} session={session} busy={busy} onBusyChange={value => { lock.current = value; setBusy(value); }} />
        <Text style={ui.section}>{myName}</Text><Text style={ui.caption}>{session.email}</Text>
        <Input label="Your UPI address" value={vpa} onChange={setVpa} />
        {vpa !== savedVpa && <><Text style={ui.caption}>Check this address. It is not bank verified.</Text><Button title="Save" kind="primary" disabled={busy || !/^[A-Za-z0-9._-]{2,}@[A-Za-z0-9.-]{2,}$/.test(vpa) || vpa.length > 254} onPress={() => launch(async () => { await request(session, '/me/payment-profile', 'PUT', { vpa }); setSavedVpa(vpa); setNotice('Saved.', 'success'); })} /></>}
      </>}
      {screen === 'notifications' && session && <PushSettings push={push} busy={busy} onBusyChange={value => { lock.current = value; setBusy(value); }} />}
      {screen === 'appearance' && <SegmentedButtons value={appearance} onValueChange={value => launch(() => changeAppearance(value as AppearancePreference))} buttons={[{ value: 'system', label: 'System', disabled: busy }, { value: 'light', label: 'Light', disabled: busy }, { value: 'dark', label: 'Dark', disabled: busy }]} />}
      {screen === 'data' && session && <>
        <Button title="Import from Splitwise" icon="bill" disabled={busy} onPress={() => navigate('import')} />
        <Button title="Export account" disabled={busy} onPress={() => launch(async () => { await shareJson('merosplit-account', await request(session, '/account/export')); })} />
        <Disclosure title="Saved changes and recovery"><Button title="Export saved changes and recovery records" disabled={busy} onPress={() => launch(exportSaved)} /></Disclosure>
        {!!unavailable.length && <Text style={[ui.notice, ui.warning]}>Access to {unavailable.length === 1 ? 'a group has' : 'some groups have'} ended. Saved work is kept for export.</Text>}
        {!!commands.length && <Disclosure title={commands.some(value => value.state !== 'pending') ? 'Needs review' : 'Pending sync'} initialOpen={commands.some(value => value.state !== 'pending')}>
          {commands.map(value => <View key={value.command_id} style={s.row}><Text style={ui.rowTitle}>{String(value.body.description ?? groups.find(row => row.group.id === value.group_id)?.group.name ?? 'Saved change')}</Text><Text style={ui.caption}>{value.error ?? (value.state === 'pending' ? 'Pending sync' : 'Needs review')}</Text>
            {!groups.some(row => row.group.id === value.group_id) && <Button title="Discard saved change" kind="text" disabled={busy} onPress={() => confirm('Discard saved change?', 'Export first if needed. This removes only your unsent change. A request already accepted by the server is kept there.', async () => { await discardCommand(await getDatabase(), owner, value.command_id); })} />}
            {groups.some(row => row.group.id === value.group_id) && <Button title="Open" kind="text" onPress={() => launch(() => openGroup(groups.find(row => row.group.id === value.group_id)!))} />}
          </View>)}
          {!expired && <Button title="Retry" disabled={busy} onPress={() => launch(sync)} />}
        </Disclosure>}
        {!!legacy.length && <Disclosure title="Earlier phone records">
          <Text style={ui.caption}>Choose only records that belong to you. Recovery links them to {session.email}. No invitations are sent.</Text>
          {legacy.map(group => <Disclosure title={group.name} key={group.id}>
            <Text style={ui.caption}>{group.expenses.length} bills · Who are you?</Text>
            {group.participants.map(person => <RadioButton.Item key={person.id} value={person.id} label={person.name} labelStyle={ui.body} mode="android" status={legacySelf[group.id] === person.id ? 'checked' : 'unchecked'} onPress={() => setLegacySelf(value => ({ ...value, [group.id]: person.id }))} />)}
            <Button title="Recover these records" disabled={busy || !legacySelf[group.id]} onPress={() => confirm('Recover to this account?', `${group.name} will be linked to ${session.email}. Original history is kept in recovery records.`, async () => {
              const result = await claimLegacyGroup(await getDatabase(), session, group.id, legacySelf[group.id], uuid);
              await load();
              if (result.status === 'conflict') { setNotice('These records need review. Their original copy is saved for export; server balances were not changed.', 'warning'); return; }
              await syncAccount(session); setGroupId(group.id); setScreen('group'); setNotice('Records recovered.', 'success');
            })} />
            <Button title="Export original records" kind="text" disabled={busy} onPress={() => launch(async () => { const db = await getDatabase(); await shareJson('merosplit-earlier-records', { group, draft: await readDraft(db, 'local', group.id), pending_commands: (await pendingCommands(db, 'local')).filter(value => value.group_id === group.id) }); })} />
          </Disclosure>)}
        </Disclosure>}
        {recoveries.some(value => value.status === 'conflict') && <Text style={[ui.notice, ui.warning]}>Some earlier records could not be safely combined. Export recovery records to review them.</Text>}
        <Button title="Privacy" kind="text" onPress={() => launch(() => Linking.openURL(`${API_URL}/privacy`))} /><Button title="Help and support" kind="text" onPress={() => launch(() => Linking.openURL(`${API_URL}/support`))} />
        <Disclosure title="Account">
          <Button title="Switch account" disabled={busy} kind="text" onPress={() => { setSignup(false); navigate('login'); }} />
          <Button title="Sign out" disabled={busy} onPress={() => confirm('Sign out?', 'Saved changes stay on this phone for your next sign-in to this account.', async () => { await draftWrites.current; await endPushSession(session); await clearMediaPreviews(); await saveSession(null); changeScope(null); })} />
          <Button title="Delete account" kind="danger" disabled={busy} onPress={() => confirm('Delete account?', 'Export first. Your account, uploads and text you added will be removed. Other members keep anonymous amounts and payment history. Unsent changes for this account will be deleted from this phone.', async () => { await push.disable().catch(() => {}); await request(session, '/account', 'DELETE'); await push.clear(); setPushTarget(null); await draftWrites.current; const db = await getDatabase(); await clearAccountMediaUploads(db, session); await wipeAccount(db, owner); await clearMediaPreviews(); await saveSession(null); changeScope(null); })} />
        </Disclosure>
      </>}
    </ScrollView>
    {screen === 'home' && session && <View style={s.tabs}>{([{ value: 'Groups', label: 'Groups', icon: 'groups' }, { value: 'Friends', label: 'People', icon: 'people' }, { value: 'Account', label: 'Me', icon: 'me' }] as const).map(item => <Pressable accessibilityRole="tab" accessibilityState={{ selected: tab === item.value, disabled: busy }} disabled={busy} key={item.value} style={[s.tab, tab === item.value && s.selectedTab]} onPress={() => { setTab(item.value); setNotice(''); }}><Icon name={item.icon} color={tab === item.value ? colors.accent : colors.muted} /><Text style={[s.tabText, tab === item.value && { color: colors.accent }]}>{item.label}</Text></Pressable>)}</View>}
  </KeyboardAvoidingView></SafeAreaView>;
}
export default function App() { return <SafeAreaProvider><UIProvider><AppContent /></UIProvider></SafeAreaProvider>; }
const makeStyles = (colors: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background }, loading: { alignItems: 'center', justifyContent: 'center', gap: 14 },
  content: { padding: 16, gap: 12, paddingBottom: 24 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 56, paddingHorizontal: 16, paddingTop: 4, paddingBottom: 8 },
  title: { flex: 1, flexShrink: 1, fontSize: 24, lineHeight: 30, fontWeight: '600', color: colors.text },
  field: { gap: 6 }, row: { gap: 6, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  groupList: { backgroundColor: colors.surface, borderRadius: radii.surface, paddingHorizontal: 12 },
  groupRow: { minHeight: 64, flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  groupMark: { width: 36, height: 36, borderRadius: radii.control, backgroundColor: colors.soft, alignItems: 'center', justifyContent: 'center' },
  pending: { fontSize: 13, color: colors.warning },
  profile: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 8 },
  tabs: { flexDirection: 'row', backgroundColor: colors.surface, marginHorizontal: 16, marginBottom: 8, borderRadius: radii.navigation, padding: 4, gap: 4 },
  tab: { flex: 1, minHeight: 48, alignItems: 'center', justifyContent: 'center', gap: 4, borderRadius: radii.surface, paddingVertical: 6 },
  tabText: { fontSize: 13, fontWeight: '500', color: colors.muted }, selectedTab: { backgroundColor: colors.soft },
});
