import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, BackHandler, Linking, Platform, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import type { AlertButton } from 'react-native';
import { Alert } from './src/alerts';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import * as Crypto from 'expo-crypto';
import { accountOwner, ApiError, requestEmailCode, confirmEmailCode, endSession, claimLegacyGroup, expensePayload, fetchGroup, refreshGroups, request, syncOutbox } from './src/api';
import type { EmailCodeChallenge } from './src/api';
import { readAppLink, subscribeAppLinks, writeAppLink, type AppLink } from './src/browserLinks';
import { validateUPIPayment, type UPILaunchQuote } from './src/upi';
import { formatMoney } from './src/accounting';
import { emptyGroup, previewPending } from './src/ledger';
import { getDatabase, savedSession, saveSession, retireSyncPause, shareJson, shareText, storageIsDurable, isOnline } from './src/native';
import { discardCommand, discardUnsentGroup, enqueue, listGroups, pendingCommands, createPendingGroup, listLegacyGroups, listLegacyRecoveries, listUnavailableGroups, readDraft, replaceCommand, saveDraft, saveGroup, readVisibleGroup, wipeAccount } from './src/storage';
import GroupScreen, { ExpenseDetail, PaymentDetail } from './src/GroupScreen';
import ExpenseForm from './src/ExpenseForm';
import type { ExpenseFormDraft } from './src/ExpenseForm';
import SettleForm from './src/SettleForm';
import ActivityScreen from './src/ActivityScreen';
import { createPaymentReturn } from './src/paymentReturn';
import type { PaymentReturn } from './src/paymentReturn';
import { listPaymentReturns, savePaymentReturn, clearPaymentReturn, resolvePaymentReturn } from './src/paymentReturnStorage';
import MembersScreen from './src/MembersScreen';
import SavedChangeScreen from './src/SavedChangeScreen';
import SplitwiseImportScreen from './src/SplitwiseImportScreen';
import AccountHeader from './src/AccountHeader';
import GroupList from './src/GroupList';
import Mascot from './src/Mascot';
import { AppFrame, pageContentStyle, ScreenHeader, AppTabs } from './src/AppNavigation';
import { EmailSignIn, CodeSignIn } from './src/SignInForms';
import { captureEmailLink, forgetEmailProof, subscribeEmailLinks, type EmailLink, type EmailTarget } from './src/emailLink';
import { resolveEmailLink, renewEmailLink, requestEmailLink } from './src/emailLinkApi';
import { resolveNativeEmailLink, renewNativeEmailLink } from './src/nativeEmailLinkApi';
import { startNativeLinks } from './src/appLinks';
import { pauseAccountRequests, resumeAccountRequests } from './src/accountRequests';
import { readBrowserSession, updateBrowserSessionMetadata } from './src/browserAuth';
import { EmailLinkScreen, EmailLinkStatus, EmailLinkSent, NameOnlyForm } from './src/EmailLinkScreens';
import CreateGroupForm from './src/CreateGroupForm';
import type { NewGroupValues } from './src/CreateGroupForm';
import { SavedChanges, LegacyRecovery as LegacyRecords } from './src/AccountRecovery';
import ProfileSettings from './src/ProfileSettings';
import { usePushNotifications } from './src/PushSettings';
import AccountNotifications from './src/AccountNotifications';
import type { PushTarget } from './src/notifications';
import BillAttachments from './src/BillAttachments';
import { clearAccountMediaUploads, clearMediaPreviews } from './src/media';
import type { CachedGroup, Command, Expense, Group, LegacyRecovery, Session, Settlement, HistoryResource, ActivityPage, ActivityTarget, BillRow } from './src/types';
import { Button, Disclosure, IconAction, SettingsRow, UIProvider, useUI, type Palette } from './src/ui';
import { visiblePeopleSummary } from './src/personalBalances';
import { useExpenseNotices } from './src/useExpenseNotices';
import type { WindowFrame } from './src/expenseNotices';
import { Text } from 'react-native-paper';

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? (Platform.OS === 'web' ? window.location.origin : Platform.OS === 'android' ? 'http://10.0.2.2:8000' : 'http://localhost:8000');
const uuid = () => Crypto.randomUUID();
type Screen = 'home' | 'create' | 'group' | 'expense' | 'expenseDetail' | 'settle' | 'members' | 'login' | 'review' | 'paymentDetail' | 'import';
type Transfer = { sender: string; recipient: string; amount: string };
type EmailEntry = { id: string | null; phase: 'opening' | 'target' | 'name' | 'error'; error: string; sent: boolean; target?: EmailTarget };
function AppContent() {
  const { palette: colors, ui, changeAppearance } = useUI();
  const s = makeStyles(colors);
  const [session, setSession] = useState<Session | null>(null), [ready, setReady] = useState(false), [expired, setExpired] = useState(false);
  const [storageError, setStorageError] = useState(''), [hasDrafts, setHasDrafts] = useState(false);
  const [verifiedEmptyOwner, setVerifiedEmptyOwner] = useState('');
  const [online, setOnline] = useState(isOnline);
  const [groups, setGroups] = useState<CachedGroup[]>([]), [commands, setCommands] = useState<Command[]>([]);
  const [screen, setScreen] = useState<Screen>('home'), [tab, setTab] = useState('Groups'), [groupId, setGroupId] = useState<string | null>(null);
  const [expenseId, setExpenseId] = useState<string | null>(null), [draft, setDraft] = useState<ExpenseFormDraft | null>(null), [transfer, setTransfer] = useState<Transfer | undefined>();
  const [reviewCommand, setReviewCommand] = useState<Command | null>(null), [reviewInput, setReviewInput] = useState<Expense | undefined>();
  const [busy, setBusy] = useState(false), [feedback, setFeedback] = useState({ text: '', tone: 'info' as 'info' | 'success' | 'warning' | 'error' });
  const notice = feedback.text;
  const setNotice = (text: string, tone: typeof feedback.tone = 'info') => setFeedback({ text, tone });
  const [email, setEmail] = useState(''), [code, setCode] = useState(''), [challenge, setChallenge] = useState<EmailCodeChallenge | null>(null), [retryAt, setRetryAt] = useState(0), [clock, setClock] = useState(Date.now());
  const [appLink, setAppLink] = useState<AppLink | null>(readAppLink);
  const initialEmailLink = useRef(Platform.OS === 'web' ? captureEmailLink() : null), emailProof = useRef(initialEmailLink.current);
  const [emailEntry, setEmailEntry] = useState<EmailEntry | null>(() => initialEmailLink.current ? { id: initialEmailLink.current.id, phase: 'opening', error: '', sent: false } : null);
  const emailEntryRef = useRef(emailEntry); emailEntryRef.current = emailEntry;
  const [emailRequested, setEmailRequested] = useState(false), [checkingCookie, setCheckingCookie] = useState(false);
  const [nativeLinksReady, setNativeLinksReady] = useState(Platform.OS === 'web');
  const authEpoch = useRef(0), cookieCheck = useRef(false), validatedBrowserSession = useRef('');
  const authHeld = !nativeLinksReady || !!emailEntry || checkingCookie, authHeldRef = useRef(authHeld); authHeldRef.current = authHeld;
  const authPending = !nativeLinksReady || checkingCookie || emailEntry?.phase === 'opening' || emailEntry?.phase === 'error';
  const [myName, setMyName] = useState('You');
  const [addPersonRequest, setAddPersonRequest] = useState(0);
  const [foreground, setForeground] = useState(AppState.currentState === 'active' && (Platform.OS !== 'web' || document.visibilityState === 'visible'));
  const scroll = useRef<React.ComponentRef<typeof ScrollView>>(null), suppressPush = useRef<(data: unknown) => boolean>(() => false);
  const [viewport, setViewport] = useState<WindowFrame | null>(null), [scrollEpoch, setScrollEpoch] = useState(0);
  const [alertOpen, setAlertOpen] = useState(false);
  const [vpa, setVpa] = useState('');
  const [returnAttemptId, setReturnAttemptId] = useState<string | null>(null);
  const [returns, setReturns] = useState<PaymentReturn[]>([]), [settlementId, setSettlementId] = useState<string | null>(null);
  const [activity, setActivity] = useState<(ActivityPage & { firstPage: boolean }) | null>(null), [activityError, setActivityError] = useState('');
  const activityOwner = useRef(''), groupVersions = useRef('');
  const [legacy, setLegacy] = useState<Group[]>([]), [recoveries, setRecoveries] = useState<LegacyRecovery[]>([]), [unavailable, setUnavailable] = useState<Group[]>([]);
  const [legacySelf, setLegacySelf] = useState<Record<string, string>>({});
  const owner = session ? accountOwner(session) : '', ownerRef = useRef(owner); ownerRef.current = owner;
  const deferredSync = useRef(false);
  const lock = useRef(false), draftWrites = useRef(Promise.resolve()), activeSessionRef = useRef(session); activeSessionRef.current = authPending ? null : session;
  const [pushTarget, setPushTarget] = useState<{ token: string; target: PushTarget | null } | null>(null);
  const push = usePushNotifications(authPending ? null : session, {
    onOpen: async target => { if (session) setPushTarget({ token: session.token, target }); },
    onForeground: async () => { if (ready && session && !authHeldRef.current && !lock.current) launch(() => sync()); },
    shouldSuppress: data => suppressPush.current(data),
  });
  const activeGroupRef = useRef(groupId); activeGroupRef.current = groupId;
  const selected = groups.find(row => row.group.id === groupId) ?? null;
  const pending = commands.filter(command => command.group_id === groupId);
  const selfId = selected?.group.participants.find(person => session && !person.removed && String(person.user_id) === session.userId)?.id ?? '';
  let preview = selected?.group ?? null, previewError = '';
  if (preview && pending.length) { try { preview = previewPending(preview, pending); } catch (error) { previewError = error instanceof Error ? error.message : 'Sync to review saved changes.'; } }
  const expense = preview?.expenses.find(value => value.id === expenseId) ?? (preview?.focused_expense?.id === expenseId ? preview.focused_expense : undefined);
  const returnPayment = returns.find(value => value.groupId === groupId && value.attemptId === returnAttemptId) ?? null;
  const settlement = selected?.group.settlements.find(value => value.id === settlementId) ?? (selected?.group.focused_settlement?.id === settlementId ? selected.group.focused_settlement : undefined);
  const notices = useExpenseNotices(session, { enabled: ready && foreground && !expired && !authHeld, visibleExpenseIds: screen === 'group' ? selected?.group.transactions?.flatMap(value => value.kind === 'bill' ? [value.bill.id] : []) ?? selected?.group.expenses.map(value => value.id) : screen === 'expenseDetail' && expense ? [expense.id] : [],
    onRefresh: async () => { if (authHeldRef.current || lock.current || !session || activeSessionRef.current?.token !== session.token) return; await perform(() => syncAccount(session), false).catch(() => {}); } });
  suppressPush.current = notices.shouldSuppress;
  const noticeVisibility = { notices: notices.notices, enabled: !authHeld && foreground && !expired && !alertOpen && !pending.length && (screen === 'group' || screen === 'expenseDetail'), viewport, scrollEpoch, onVisible: notices.acknowledgeVisible };
  function measureViewport() { scroll.current?.measureInWindow((x, y, width, height) => setViewport({ x, y, width, height })); }
  function navigate(value: Screen) { setNotice(''); setScreen(value); }
  function changeScope(value: Session | null) {
    setVerifiedEmptyOwner('');
    ownerRef.current = value ? accountOwner(value) : '';
    activeSessionRef.current = value;
    setSession(value); setExpired(false); setGroups([]); setCommands([]); setLegacy([]); setRecoveries([]); setUnavailable([]); setLegacySelf({});
    setGroupId(null); setExpenseId(null); setDraft(null); setVpa(''); setScreen(value ? 'home' : 'login'); setTab('Groups');
    setMyName(value?.displayName || value?.email.split('@')[0] || 'You');
    setReviewCommand(null); setReviewInput(undefined); setReturns([]); setReturnAttemptId(null); setSettlementId(null); setActivity(null); setActivityError(''); activityOwner.current = ''; groupVersions.current = '';
    void load(ownerRef.current).catch(error => setNotice(error.message, 'error'));
  }
  async function load(scope = ownerRef.current) {
    if (!scope) return;
    const db = await getDatabase();
    const [rows, queue, older, backups, hidden, draftCount, savedReturns] = await Promise.all([listGroups(db, scope), pendingCommands(db, scope), listLegacyGroups(db), listLegacyRecoveries(db, scope), listUnavailableGroups(db, scope), db.getFirstAsync<{ n: number }>('SELECT count(*) AS n FROM drafts WHERE owner=? AND body<>?', scope, 'null'), listPaymentReturns(db, scope)]);
    if (ownerRef.current === scope) {
      const versions = rows.map(row => `${row.group.id}:${row.group.version}`).sort().join('|');
      if (groupVersions.current !== versions) { groupVersions.current = versions; setActivity(null); activityOwner.current = ''; }
      setGroups(rows); setCommands(queue); setLegacy(older); setRecoveries(backups); setUnavailable(hidden); setHasDrafts(!!draftCount?.n); setReturns(savedReturns);
    }
  }
  async function perform<T,>(action: () => Promise<T>, reportError = true): Promise<T> {
    if (lock.current) throw new Error('Please wait for the current action.');
    lock.current = true; setBusy(true); setNotice('');
    try { return await action(); }
    catch (error) { const expired = error instanceof ApiError && error.status === 401; if (expired) setExpired(true); if (reportError || expired) setNotice(expired ? 'Sign in again to continue. Your saved changes are safe.' : error instanceof Error ? error.message : 'Could not save. Please try again.', 'error'); throw error; }
    finally { await load().catch(() => {}); lock.current = false; setBusy(false); }
  }
  const launch = (action: () => Promise<unknown>) => { void perform(action).catch(() => {}); };
  function showAlert(title: string, message: string, buttons: AlertButton[]) {
    setAlertOpen(true);
    const close = () => setAlertOpen(false);
    Alert.alert(title, message, buttons.map(button => ({ ...button, onPress: () => { close(); button.onPress?.(); } })), { cancelable: true, onDismiss: close });
  }
  function confirm(title: string, message: string, action: () => Promise<unknown>) {
    showAlert(title, message, [{ text: 'Cancel', style: 'cancel' }, { text: 'Confirm', onPress: () => launch(action) }]);
  }
  // Persist profile metadata under the existing action lock, never over another account's session.
  async function rememberName(active: Session, displayName: string) {
    const current = () => ownerRef.current === accountOwner(active) && activeSessionRef.current?.token === active.token;
    if (!current()) return;
    if (activeSessionRef.current?.displayName !== displayName) {
      const updated = { ...active, displayName };
      if (Platform.OS === 'web') { if (!updateBrowserSessionMetadata(active, updated)) return; } else await saveSession(updated);
      if (current()) { activeSessionRef.current = updated; setSession(updated); }
    }
    if (current()) setMyName(displayName || active.email.split('@')[0] || 'You');
  }
  async function readProfile(active: Session) {
    const me = await request<{ display_name?: string; payment_profile: { vpa: string } | null }>(active, '/me');
    await rememberName(active, me.display_name ?? active.displayName ?? '');
    return me;
  }
  async function saveName(display_name: string, onlyIfUnnamed = false) {
    await perform(async () => {
      if (!session) throw new Error('Sign in to continue.');
      const active = session, result = await request<{ display_name: string }>(active, '/me/profile', 'PUT', { display_name, ...(onlyIfUnnamed ? { only_if_unnamed: true } : {}) });
      if (typeof result.display_name !== 'string' || !result.display_name.trim()) throw new Error('Could not confirm the saved name. Try again.');
      await rememberName(active, result.display_name);
      try { await refreshGroups(await getDatabase(), active, 'summary'); await load(accountOwner(active)); }
      catch { setNotice('Name saved. Reconnect to refresh your groups.', 'warning'); }
    }, false);
  }
  async function syncAccount(active: Session) {
    setVerifiedEmptyOwner('');
    const db = await getDatabase(), scope = accountOwner(active);
    await readProfile(active);
    let writeError: unknown;
    try { await syncOutbox(db, active, 'summary'); } catch (error) { if (error instanceof ApiError && error.status === 401) throw error; writeError = error; }
    const removed = await refreshGroups(db, active, 'summary');
    await load(scope);
    if (ownerRef.current !== scope) return;
    if (activeGroupRef.current && removed.includes(activeGroupRef.current)) { setGroupId(null); setScreen('home'); setNotice('You no longer have access to that group.', 'warning'); }
    if (writeError) throw writeError;
    if (activeSessionRef.current?.token === active.token) setVerifiedEmptyOwner(scope);
  }
  async function sync() {
    if (!session) throw new Error('Sign in to continue.');
    await syncAccount(session);
  }
  async function withBill(active: Session, group: Group, id?: string): Promise<Group> {
    if (!id || group.expenses.some(value => value.id === id) || group.focused_expense?.id === id) return group;
    const detail = await request<Expense & { group_version: number; group_id: string }>(active, `/groups/${group.id}/expenses/${encodeURIComponent(id)}?version=${group.version}`);
    if (detail.group_version !== group.version || detail.group_id !== group.id) throw new Error('This bill changed. Refresh the group and try again.');
    return { ...group, focused_expense: detail };
  }
  async function openBill(bill: BillRow) {
    await perform(async () => {
      if (!session || !selected) return;
      const active = session, group = await withBill(active, selected.group, bill.id);
      if (activeSessionRef.current?.token !== active.token) return;
      await saveGroup(await getDatabase(), accountOwner(active), group, 'shared');
      setExpenseId(bill.id); navigate('expenseDetail');
    });
  }
  async function withPayment(active: Session, group: Group, id: string): Promise<Group> {
    if (group.settlements.some(value => value.id === id) || group.focused_settlement?.id === id) return group;
    const payment = await request<Settlement & { group_version: number }>(active, `/groups/${group.id}/settlements/${encodeURIComponent(id)}?version=${group.version}`);
    if (payment.id !== id || payment.group_version !== group.version) throw new Error('This payment changed. Refresh and try again.');
    return { ...group, focused_settlement: payment };
  }
  async function openPayment(id: string) {
    await perform(async () => {
      if (!session || !selected) return;
      const active = session, group = await withPayment(active, selected.group, id);
      if (activeSessionRef.current?.token !== active.token) return;
      await saveGroup(await getDatabase(), accountOwner(active), group, 'shared');
      setSettlementId(id); navigate('paymentDetail');
    });
  }
  async function refreshActivity(more = false) {
    const active = session;
    if (!active) return;
    await perform(async () => {
      setActivityError('');
      try {
        const cursor = more ? activity?.next_cursor : null;
        if (more && !cursor) return;
        const page = await request<ActivityPage>(active, `/activity?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
        if (page.read_mode !== 'activity' || !Array.isArray(page.items) || more && page.revision !== activity?.revision) throw new Error('Activity changed. Refresh to see the latest.');
        if (activeSessionRef.current?.token !== active.token) return;
        activityOwner.current = accountOwner(active);
        setActivity({ ...page, firstPage: !more }); requestAnimationFrame(() => scroll.current?.scrollTo({ y: 0, animated: false }));
      } catch (error) {
        if (activeSessionRef.current?.token !== active.token) return;
        if (error instanceof ApiError && error.status === 409) { setActivity(null); activityOwner.current = ''; }
        setActivityError(error instanceof ApiError && error.status === 409 ? 'Activity changed. Refresh to see the latest.' : 'Could not load activity. Try again.');
        throw error;
      }
    }, false);
  }
  useEffect(() => {
    if (ready && session && !authHeld && !expired && foreground && screen === 'home' && tab === 'Activity' && !busy && activityOwner.current !== owner && !activityError) void refreshActivity().catch(() => {});
  }, [ready, session?.token, authHeld, expired, foreground, screen, tab, busy, owner, activityError]);
  async function openActivityTarget(target: ActivityTarget) {
    await perform(async () => {
      if (!session) return;
      const active = session;
      let group = await fetchGroup(active, target.groupId);
      if (target.kind === 'bill') group = await withBill(active, group, target.expenseId);
      if (target.kind === 'payment') group = await withPayment(active, group, target.settlementId);
      if (activeSessionRef.current?.token !== active.token) return;
      await saveGroup(await getDatabase(), accountOwner(active), group, 'shared');
      setGroupId(group.id); setExpenseId(target.kind === 'bill' ? target.expenseId : null); setSettlementId(target.kind === 'payment' ? target.settlementId : null);
      setScreen(target.kind === 'bill' ? 'expenseDetail' : target.kind === 'payment' ? 'paymentDetail' : 'group');
    });
  }
  async function armPaymentReturn(payment: Transfer, quote: UPILaunchQuote): Promise<PaymentReturn> {
    if (!session || !groupId || !selected || pending.length || payment.sender !== selfId || quote.amount !== payment.amount) throw new Error('Review the payment again before opening UPI.');
    const scope = owner, active = session, db = await getDatabase();
    const previous = (await listPaymentReturns(db, scope)).find(value => value.attemptId === quote.id);
    const now = new Date(), date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const record = previous ?? createPaymentReturn({ groupId, groupVersion: quote.group_version, attemptId: quote.id, ...payment, payeeName: quote.recipient, vpa: quote.vpa, yesCommandId: uuid(), noCommandId: uuid(), settlementId: uuid(), date });
    if (ownerRef.current !== scope || activeSessionRef.current?.token !== active.token) throw new Error('Sign in again to continue.');
    await savePaymentReturn(db, scope, record);
    setReturnAttemptId(record.attemptId);
    if (ownerRef.current === scope && activeSessionRef.current?.token === active.token) { setReturns(values => [...values.filter(value => value.attemptId !== record.attemptId), record]); setHasDrafts(true); }
    return record;
  }
  async function persistPaymentReturn(next: PaymentReturn | null) {
    if (!session) throw new Error('Sign in to continue.');
    const active = session, scope = accountOwner(active), db = await getDatabase();
    if (activeSessionRef.current?.token !== active.token) throw new Error('Sign in to continue.');
    if (next) await savePaymentReturn(db, scope, next);
    else if (returnPayment) await clearPaymentReturn(db, scope, returnPayment.attemptId);
    if (activeSessionRef.current?.token !== active.token) return;
    setReturns(values => next ? [...values.filter(value => value.attemptId !== next.attemptId), next] : values.filter(value => value.attemptId !== returnPayment?.attemptId));
    if (next) setHasDrafts(true);
  }
  async function finishPaymentReturn(record: PaymentReturn, paid: boolean) {
    await perform(async () => {
      if (!session || record.decision !== (paid ? 'paid' : 'unpaid')) throw new Error('Review the saved payment again.');
      const active = session, group = await resolvePaymentReturn(await getDatabase(), active, record);
      if (activeSessionRef.current?.token !== active.token) return;
      setGroupId(group.id); setTransfer(undefined); setScreen('group');
      setActivity(null); activityOwner.current = '';
      setNotice(paid ? `Recorded ${formatMoney(record.amount)} paid to ${record.payeeName}.` : 'Unpaid attempt cancelled.', paid ? 'success' : 'info');
    }, false);
  }
  async function historyPage(resource: HistoryResource, direction: 'next' | 'previous' | 'search', query?: string, target?: Group) {
    await perform(async () => {
      const group = target ?? selected?.group;
      if (!group?.history || !session) return;
      const window = group.history![resource]; if (!window) return;
      const previous = window.previous ?? [];
      const cursor = direction === 'next' ? window.next_cursor : direction === 'previous' ? previous.at(-1) ?? null : null;
      const search = ['bills', 'transactions'].includes(resource) ? query ?? window.query ?? '' : '';
      const params = new URLSearchParams({ version: String(group.version), limit: '50' });
      if (cursor) params.set('cursor', cursor);
      if (resource === 'bills' || resource === 'transactions') { params.set('deleted', 'all'); if (search) params.set('q', search); }
      try {
        const page = await request<{ read_mode: string; group_id: string; version: number; items: unknown[]; next_cursor: string | null }>(session, `/groups/${group.id}/history/${resource}?${params}`);
        if (page.read_mode !== 'page' || page.group_id !== group.id || page.version !== group.version) throw new Error('History changed. Refresh before continuing.');
        const field = { bills: 'expenses', activity: 'activity', settlements: 'settlements', attempts: 'payment_attempts', transactions: 'transactions' }[resource];
        await saveGroup(await getDatabase(), owner, { ...group, [field]: page.items, history: { ...group.history!, [resource]: { next_cursor: page.next_cursor, cursor, previous: direction === 'next' ? [...previous, window.cursor ?? null] : direction === 'previous' ? previous.slice(0, -1) : [], query: search } } }, 'shared');
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) {
          await saveGroup(await getDatabase(), owner, await fetchGroup(session, group.id), 'shared');
          throw new Error('History changed. Showing the latest records. Your saved changes are kept.');
        }
        throw error;
      }
    });
    requestAnimationFrame(() => scroll.current?.scrollTo({ y: 0, animated: false }));
  }
  useEffect(() => { if (ready && session && foreground && !expired && !authHeld) notices.engage(); }, [ready, session?.token, foreground, expired, authHeld]);
  useEffect(() => {
    const update = () => { const active = AppState.currentState === 'active' && (Platform.OS !== 'web' || document.visibilityState === 'visible'); if (active) activityOwner.current = ''; setForeground(active); if (active) requestAnimationFrame(measureViewport); };
    const listener = AppState.addEventListener('change', update);
    if (Platform.OS === 'web') { document.addEventListener('visibilitychange', update); window.addEventListener('resize', measureViewport); window.addEventListener('pointerdown', notices.engage); window.addEventListener('keydown', notices.engage); }
    return () => { listener.remove(); if (Platform.OS === 'web') { document.removeEventListener('visibilitychange', update); window.removeEventListener('resize', measureViewport); window.removeEventListener('pointerdown', notices.engage); window.removeEventListener('keydown', notices.engage); } };
  }, []);
  useEffect(() => {
    if (Platform.OS !== 'web' || storageIsDurable() || !commands.length && !hasDrafts) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [commands.length, hasDrafts]);
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const update = () => setOnline(isOnline());
    window.addEventListener('online', update); window.addEventListener('offline', update);
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update); };
  }, []);
  function openMe() { setTab('Account'); navigate('home'); }
  useEffect(() => {
    if (!challenge && !emailRequested) return;
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [challenge, emailRequested]);
  useEffect(() => subscribeAppLinks(target => {
    if (authHeldRef.current) return;
    void draftWrites.current.then(() => { if (authHeldRef.current) return; setAppLink(target); if (!target) { setGroupId(null); setExpenseId(null); navigate(session ? 'home' : 'login'); } });
  }), [session?.token]);
  useEffect(() => {
    if (!ready || !session || authHeld || expired || busy || !appLink) return;
    const active = session, target = appLink;
    launch(async () => {
      await draftWrites.current;
      try {
        const id = 'inviteToken' in target
          ? (await request<{ id: string }>(active, `/invites/${encodeURIComponent(String(target.inviteToken))}/claim`, 'POST', { command_id: uuid() })).id
          : target.groupId;
        let group: Group;
        try { group = await fetchGroup(active, id); }
        catch (error) {
          const cached = await readVisibleGroup(await getDatabase(), accountOwner(active), id);
          if (error instanceof ApiError && error.status < 500 || !cached || cached.kind === 'unavailable') throw error;
          group = cached.group;
        }
        group = await withBill(active, group, target.expenseId);
        if (activeSessionRef.current?.token !== active.token) return;
        await saveGroup(await getDatabase(), accountOwner(active), group, 'shared');
        setGroupId(group.id); setTab(group.is_direct ? 'Friends' : 'Groups');
        const bill = target.expenseId && (group.expenses.find(value => value.id === target.expenseId) ?? (group.focused_expense?.id === target.expenseId ? group.focused_expense : undefined));
        setExpenseId(bill ? bill.id : null); setDraft(null); setScreen(bill ? 'expenseDetail' : 'group');
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) { setScreen('home'); setNotice('This link is unavailable, or your request is waiting for approval.', 'warning'); }
        else throw error;
      } finally { setAppLink(null); }
    });
  }, [ready, session?.token, authHeld, expired, busy, appLink]);
  useEffect(() => {
    if (!ready || !session || authHeld || appLink || busy) return;
    if (screen === 'group' || screen === 'expenseDetail') writeAppLink(groupId ? { groupId, ...(screen === 'expenseDetail' && expenseId ? { expenseId } : {}) } : null);
    else if (screen === 'home') writeAppLink(null);
  }, [ready, session?.token, authHeld, appLink, busy, screen, groupId, expenseId]);
  useEffect(() => {
    if (authHeld || screen !== 'home' || tab !== 'Account' || !session || expired) return;
    const active = session;
    void perform(async () => {
      const me = await readProfile(active);
      if (activeSessionRef.current?.token !== active.token) return;
      setVpa(me.payment_profile?.vpa ?? '');
    }, false).catch(() => {});
  }, [screen, tab, session?.token, expired, authHeld]);
  async function restore() {
    const epoch = authEpoch.current;
    try {
      const [value] = await Promise.all([savedSession(), retireSyncPause(), getDatabase()]);
      // Native links can arrive before SecureStore hydration finishes. Keep
      // that saved identity available to rotate its session and device binding.
      if (epoch !== authEpoch.current && Platform.OS === 'web') return;
      changeScope(value); setStorageError('');
      if (authHeldRef.current) activeSessionRef.current = null;
      if (value) setEmail(value.email);
    } catch (error) { if (epoch === authEpoch.current || Platform.OS !== 'web') setStorageError(error instanceof Error ? error.message : 'Could not open saved records. Retry without clearing app data.'); }
    finally { setReady(true); }
  }
  useEffect(() => { void restore(); }, []);
  useEffect(() => { if (ready && owner) void load().catch(error => setNotice(error.message, 'error')); }, [owner, ready]);
  useEffect(() => {
    if (!ready || !session || authHeld || expired) return;
    const reconnect = () => { if (authHeldRef.current) return; if (Platform.OS === 'web') queueCookieCheck(); else if (!lock.current) launch(() => sync()); else deferredSync.current = true; };
    if (Platform.OS === 'web' && validatedBrowserSession.current === session.token) { if (!lock.current) launch(sync); else deferredSync.current = true; } else reconnect();
    const listener = AppState.addEventListener('change', state => { if (state === 'active') reconnect(); });
    if (Platform.OS === 'web') window.addEventListener('online', reconnect);
    return () => { listener.remove(); if (Platform.OS === 'web') window.removeEventListener('online', reconnect); };
  }, [owner, ready, expired, session?.token, authHeld]);
  useEffect(() => {
    if (ready && session && !authHeld && !expired && !busy && deferredSync.current) { deferredSync.current = false; launch(sync); }
  }, [ready, session?.token, authHeld, expired, busy]);
  useEffect(() => {
    if (!ready || busy || authHeld || !pushTarget) return;
    setPushTarget(null);
    if (!session || pushTarget.token !== session.token) return;
    const active = session, scope = accountOwner(active);
    launch(async () => {
      await draftWrites.current;
      let target = pushTarget.target;
      if (target) {
        try {
          let group = await fetchGroup(active, target.group.id);
          group = await withBill(active, group, target.expenseId ?? undefined);
          target = { group, expenseId: group.expenses.some(value => value.id === target?.expenseId && !value.deleted) || group.focused_expense?.id === target.expenseId ? target.expenseId : null };
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
  }, [ready, busy, authHeld, pushTarget, session?.token]);
  async function endPushSession(active: Session) {
    await push.disable().catch(() => {});
    await endSession(active);
    await push.clear(); setPushTarget(null);
  }
  function back() {
    if (screen === 'expense' || screen === 'expenseDetail' || screen === 'settle' || screen === 'members' || screen === 'review' || screen === 'paymentDetail') navigate('group');
    else if (screen === 'import') openMe();
    else navigate(session ? 'home' : 'login');
  }
  useEffect(() => { const event = BackHandler.addEventListener('hardwareBackPress', () => { if (busy) return true; if (screen === 'home' || !session && screen === 'login') return false; back(); return true; }); return () => event.remove(); }, [screen, busy, !!session]);
  function command(method: Command['method'], path: string, body: Record<string, unknown>): Command {
    const id = typeof body.command_id === 'string' ? body.command_id : uuid(); return { command_id: id, group_id: groupId!, base_version: selected?.group.version ?? 0, method, path, body: { ...body, command_id: id }, state: 'pending', error: null };
  }
  function requireConnectionForTemporaryStorage() {
    if (!storageIsDurable() && !isOnline()) throw new Error('This temporary browser tab needs an internet connection to save changes. Keep the tab open and reconnect.');
  }
  async function queue(value: Command, replacing?: string) {
    requireConnectionForTemporaryStorage();
    if (replacing) await replaceCommand(await getDatabase(), owner, replacing, value);
    else await enqueue(await getDatabase(), owner, value);
    if (session) {
      try { await syncOutbox(await getDatabase(), session, 'summary'); return; }
      catch (error) { if (error instanceof ApiError && error.status === 401) setExpired(true); setNotice(storageIsDurable() ? 'Pending sync. Your change is saved.' : 'Not confirmed by the server. Keep this tab open and reconnect to retry.', 'warning'); return; }
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
      let attempt = selected.group.payment_attempts?.find(attempt => attempt.sender === value.sender && attempt.recipient === value.recipient && ['prepared', 'reported'].includes(attempt.state) && !pending.some(command => command.path.endsWith('/settlements') && command.body.attempt_id === attempt.id));
      if (!attempt && session && isOnline()) {
        try { attempt = (await request<{ items: NonNullable<Group['payment_attempts']> }>(session, `/groups/${groupId}/history/attempts?sender=${value.sender}&recipient=${value.recipient}&state=active`)).items[0]; }
        catch (error) { if (!storageIsDurable() || error instanceof ApiError && error.status < 500) throw error; }
      }
      await queue(command('POST', `/groups/${groupId}/settlements`, { id: paymentId, ...value, date, ...(attempt ? { attempt_id: attempt.id } : {}) }));
      navigate('group');
    });
  }
  async function reviewChange(value: Command) {
    if (!session || !groupId) throw new Error('Sign in to continue.');
    let group = await fetchGroup(session, groupId);
    try { group = await withBill(session, group, String(value.body.id ?? '')); }
    catch (error) { if (!(error instanceof ApiError && error.status === 404 && value.method === 'POST')) throw error; }
    await saveGroup(await getDatabase(), owner, group, 'shared'); setReviewCommand(value); navigate('review');
  }
  async function reversePayment(value: Settlement) {
    if (!selected) return;
    if (selected.group.archived) throw new Error('Reopen this group in settings before making changes.');
    await queue(command('POST', `/groups/${groupId}/settlements/${value.id}/reverse`, {}));
  }
  async function groupAction(suffix: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return perform(async () => {
      if (!session) throw new Error('Sign in to continue.');
      requireConnectionForTemporaryStorage();
      const retrying = pending.length === 1 && pending[0].state === 'pending' && body.command_id === pending[0].command_id;
      if (pending.length && !retrying) throw new Error('Review pending changes first.');
      await enqueue(await getDatabase(), owner, command('POST', `/groups/${groupId}${suffix}`, body));
      const receipts = await syncOutbox(await getDatabase(), session, 'summary'); return receipts.at(-1) ?? {};
    });
  }
  async function reviewPaymentAttempt(sender: string, recipient: string) {
    if (!session || !groupId) return;
    const active = session, scope = accountOwner(active), id = groupId;
    let group = await fetchGroup(active, id);
    const page = await request<{ version: number; items: NonNullable<Group['payment_attempts']> }>(active, `/groups/${id}/history/attempts?sender=${sender}&recipient=${recipient}&state=active&version=${group.version}`);
    if (ownerRef.current !== scope || activeSessionRef.current?.token !== active.token || activeGroupRef.current !== id || page.version !== group.version) return;
    const current = await readVisibleGroup(await getDatabase(), scope, id);
    if (current && current.group.version > group.version || activeSessionRef.current?.token !== active.token || activeGroupRef.current !== id) return;
    if (current?.group.version === group.version) group = current.group;
    group = { ...group, payment_attempts: [...(group.payment_attempts ?? []).filter(value => !(value.sender === sender && value.recipient === recipient && ['prepared', 'reported'].includes(value.state))), ...page.items] };
    await saveGroup(await getDatabase(), scope, group, 'shared'); await load(scope);
  }
  async function prepareUPI(payment: Transfer): Promise<UPILaunchQuote> {
    return perform(async () => {
      if (!session || !groupId) throw new Error('Open a group first.');
      if (pending.length) throw new Error('Sync or review saved changes before paying.');
      const db = await getDatabase();
      let group = await fetchGroup(session, groupId!);
      const payer = group.participants.find(person => !person.removed && String(person.user_id) === session.userId)?.id ?? '';
      validateUPIPayment(group, payer, payment);
      const activeAttempt = async () => {
        const attempt = (await request<{ items: NonNullable<Group['payment_attempts']> }>(session, `/groups/${groupId}/history/attempts?sender=${payment.sender}&recipient=${payment.recipient}&state=active&version=${group.version}`)).items[0];
        if (attempt) { group = { ...group, payment_attempts: [...(group.payment_attempts ?? []).filter(value => value.id !== attempt.id), attempt] }; await saveGroup(db, owner, group, 'shared'); }
        return attempt;
      };
      let attempt = await activeAttempt();
      if (attempt && (attempt.state !== 'prepared' || attempt.amount !== payment.amount)) throw new Error('Review the existing payment. Cancel an unpaid attempt before changing its amount.');
      if (!attempt) {
        const payee = group.participants.find(person => person.id === payment.recipient)?.payment_profile;
        if (!payee) throw new Error('Ask this person to add their UPI address.');
        await enqueue(db, owner, command('POST', `/groups/${groupId}/payment-attempts`, { id: uuid(), ...payment, group_version: group.version, payee_version: payee.version }));
        await syncOutbox(db, session, 'summary');
        group = (await listGroups(db, owner)).find(row => row.group.id === groupId)!.group;
        attempt = await activeAttempt();
      } else await saveGroup(db, owner, group, 'shared');
      if (!attempt) throw new Error('Payment details changed. Review again.');
      return request<UPILaunchQuote>(session, `/groups/${groupId}/payment-attempts/${attempt.id}/launch`);
    });
  }
  async function sendSignInLink() {
    const value = await requestEmailLink(API_URL, email);
    setEmailRequested(true); setChallenge(value); setCode(''); setRetryAt(Date.now() + value.retryAfter * 1000); setClock(Date.now());
  }
  async function sendSignInCode() {
    setEmailRequested(false);
    const value = await requestEmailCode(API_URL, email, true);
    setChallenge(value); setRetryAt(Date.now() + value.retryAfter * 1000); setCode(''); setClock(Date.now());
  }
  async function finishSignIn() {
    if (!challenge) return;
    const intendedEmail = email.trim().toLowerCase();
    const epoch = ++authEpoch.current;
    if (Platform.OS === 'web') { authHeldRef.current = true; activeSessionRef.current = null; setCheckingCookie(true); await pauseAccountRequests(); }
    try {
      await draftWrites.current;
      if (epoch !== authEpoch.current) return;
      let value: Session;
      try { value = await confirmEmailCode(API_URL, challenge.challengeId, code); }
      catch (error) {
        if (Platform.OS !== 'web' || epoch !== authEpoch.current) throw error;
        // An accepted response can be lost after its cookie reached the browser.
        const current = await readBrowserSession(API_URL, null);
        if (!current || current.email.toLowerCase() !== intendedEmail) throw error;
        value = current;
      }
      if (epoch !== authEpoch.current) return;
      await saveSession(value);
      if (epoch !== authEpoch.current) return;
      if (session && session.token !== value.token) { if (Platform.OS !== 'web') await endPushSession(session); else await push.clear(); await clearMediaPreviews(); }
      if (epoch !== authEpoch.current) return;
      validatedBrowserSession.current = value.token; changeScope(value); setChallenge(null); setCode('');
      if (Platform.OS === 'web') { resumeAccountRequests(); setCheckingCookie(false); authHeldRef.current = false; }
      await syncAccount(value);
    } finally {
      if (Platform.OS === 'web' && epoch === authEpoch.current && !emailEntryRef.current) { authHeldRef.current = false; setCheckingCookie(false); resumeAccountRequests(); }
    }
  }
  async function createGroup(values: NewGroupValues) {
    if (!session) throw new Error('Sign in first.');
    requireConnectionForTemporaryStorage();
    const participants = [myName, ...values.people].map((name, index) => ({ id: uuid(), name: name.trim(), user_id: index === 0 ? Number(session.userId) : null, ...(direct && index === 1 && values.email.trim() ? { email: values.email.trim() } : {}) }));
    const group = { ...emptyGroup(uuid(), direct ? values.people[0].trim() : values.name, participants), owner_id: Number(session.userId), is_direct: direct };
    const id = uuid(), create: Command = { command_id: id, group_id: group.id, base_version: 0, method: 'POST', path: '/groups', body: { command_id: id, id: group.id, name: group.name, participants: participants.map(({ id, name, email }) => ({ id, name, ...(email ? { email } : {}) })), self_participant_id: participants[0].id, is_direct: direct }, state: 'pending', error: null };
    await createPendingGroup(await getDatabase(), owner, group, [create]);
    try { await syncOutbox(await getDatabase(), session, 'summary'); }
    catch (error) { if (error instanceof ApiError && error.status === 401) setExpired(true); setNotice(storageIsDurable() ? 'Saved. Reconnect to finish syncing.' : 'Not confirmed by the server. Keep this tab open and reconnect to retry.', 'warning'); }
    setGroupId(group.id); setExpenseId(null); setDraft(null); setScreen('group');
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
  function beginEmailLink(link: EmailLink) {
    const previous = emailProof.current;
    if (emailEntryRef.current && previous?.id === link.id && (previous.proof === link.proof || emailEntryRef.current.phase !== 'opening' && !previous.proof)) return;
    authEpoch.current++; authHeldRef.current = true; activeSessionRef.current = null;
    emailProof.current = link; cookieCheck.current = false; setCheckingCookie(false); setAppLink(null); setPushTarget(null);
    void pauseAccountRequests();
    const next: EmailEntry = { id: link.id, phase: 'opening', error: '', sent: false };
    emailEntryRef.current = next; setEmailEntry(next);
  }
  function queueCookieCheck(force = false) {
    if (Platform.OS !== 'web' || authHeldRef.current && !force) return;
    if (force) {
      authEpoch.current++;
      const entry = emailEntryRef.current;
      if (entry) { const next: EmailEntry = { ...entry, phase: 'opening', error: '', sent: false }; emailEntryRef.current = next; setEmailEntry(next); }
    }
    cookieCheck.current = true; authHeldRef.current = true; activeSessionRef.current = null;
    setCheckingCookie(true); void pauseAccountRequests();
  }
  async function openEmailTarget(active: Session, target: EmailTarget, epoch: number) {
    await readProfile(active);
    if (epoch !== authEpoch.current) return;
    if (target.kind === 'group') {
      const group = await fetchGroup(active, target.group_id);
      if (epoch !== authEpoch.current || activeSessionRef.current?.token !== active.token) return;
      await saveGroup(await getDatabase(), accountOwner(active), group, 'shared'); await load(accountOwner(active));
      if (epoch !== authEpoch.current || activeSessionRef.current?.token !== active.token) return;
      setGroupId(group.id); setTab(group.is_direct ? 'Friends' : 'Groups'); setExpenseId(null); setScreen('group');
    } else { setTab('Groups'); setScreen('home'); }
    if (epoch === authEpoch.current) { forgetEmailProof(); emailProof.current = null; emailEntryRef.current = null; setEmailEntry(null); }
  }
  useEffect(() => {
    if (Platform.OS !== 'web') return startNativeLinks(Linking, value => {
      if (value.kind === 'email') beginEmailLink(value.link);
      else setAppLink(value.target);
    }, () => setNativeLinksReady(true));
    if (initialEmailLink.current) void pauseAccountRequests();
    const unsubscribe = subscribeEmailLinks(beginEmailLink);
    const changed = (event: StorageEvent) => {
      if (event.key !== 'merosplit.web.session') return;
      try { if (event.newValue && JSON.parse(event.newValue).token === activeSessionRef.current?.token) return; } catch { /* Revalidate rather than trust malformed metadata. */ }
      queueCookieCheck(true);
    };
    window.addEventListener('storage', changed);
    return () => { unsubscribe(); window.removeEventListener('storage', changed); };
  }, []);
  async function finishEmailLink(entry: EmailEntry | null, epoch: number) {
    await pauseAccountRequests(); await draftWrites.current;
    if (epoch !== authEpoch.current) return;
    if (cookieCheck.current) {
      const active = await savedSession();
      if (epoch !== authEpoch.current) return;
      const prior = session;
      if (active?.token !== prior?.token) { await push.clear(); await clearMediaPreviews(); changeScope(active); }
      else { activeSessionRef.current = active; setSession(active); }
      validatedBrowserSession.current = active?.token ?? '';
      cookieCheck.current = false; setCheckingCookie(false);
      if (!entry || !active || active.userId !== prior?.userId || active.baseUrl !== prior.baseUrl) {
        // A later account change supersedes this tab's unfinished link or Name step.
        forgetEmailProof(); initialEmailLink.current = null; emailProof.current = null; emailEntryRef.current = null; setEmailEntry(null);
        authHeldRef.current = false; resumeAccountRequests();
        return;
      }
    }
    if (!entry?.id) throw new Error('This link has expired or was already used.');
    const proof = emailProof.current?.id === entry.id ? emailProof.current.proof : null;
    const prior = Platform.OS === 'web' ? session : await savedSession();
    if (epoch !== authEpoch.current) return;
    const result = Platform.OS === 'web'
      ? await resolveEmailLink(API_URL, { id: entry.id, proof }, () => epoch === authEpoch.current)
      : await resolveNativeEmailLink(API_URL, { id: entry.id, proof }, () => epoch === authEpoch.current, prior ?? undefined);
    if (!result || epoch !== authEpoch.current) return;
    await saveSession(result.session);
    if (epoch !== authEpoch.current) return;
    if (result.session.token !== prior?.token) await push.clear();
    await clearMediaPreviews(); setPushTarget(null);
    if (epoch !== authEpoch.current) return;
    validatedBrowserSession.current = result.session.token; changeScope(result.session); setChallenge(null); setCode(''); setEmailRequested(false);
    forgetEmailProof(); initialEmailLink.current = null; emailProof.current = { id: entry.id, proof: null };
    const next: EmailEntry = { ...entry, phase: result.needsName ? 'name' : 'target', target: result.target };
    emailEntryRef.current = next; setEmailEntry(next); cookieCheck.current = false; setCheckingCookie(false); resumeAccountRequests();
    if (!result.needsName) await openEmailTarget(result.session, result.target, epoch);
  }
  useEffect(() => {
    if (!ready || !nativeLinksReady || busy || lock.current || !foreground || Platform.OS === 'web' && document.visibilityState !== 'visible') return;
    const entry = emailEntry;
    if (entry?.phase !== 'opening' && !cookieCheck.current) return;
    const epoch = authEpoch.current;
    void perform(() => finishEmailLink(entry, epoch), false).catch(error => {
      if (epoch !== authEpoch.current) return;
      cookieCheck.current = false; setCheckingCookie(false);
      if (entry) { const next: EmailEntry = { ...(emailEntryRef.current ?? entry), phase: 'error', error: error instanceof ApiError && [403, 404].includes(error.status) ? 'This page is not available.' : error instanceof Error ? error.message : 'Could not connect. Try again.', sent: false }; emailEntryRef.current = next; setEmailEntry(next); }
      else { authHeldRef.current = false; resumeAccountRequests(); setNotice('Could not check this account. Refresh to try again.', 'error'); }
    });
  }, [ready, nativeLinksReady, busy, foreground, emailEntry?.phase, emailEntry?.id, checkingCookie]);
  async function finishEmailName(name: string) {
    const entry = emailEntryRef.current, active = session, epoch = authEpoch.current;
    if (!entry?.target || !active) throw new Error('Open the email link again.');
    await saveName(name, true);
    if (epoch !== authEpoch.current) return;
    const next: EmailEntry = { ...entry, phase: 'target' }; emailEntryRef.current = next; setEmailEntry(next);
    try { await perform(() => openEmailTarget(activeSessionRef.current ?? active, entry.target!, epoch), false); }
    catch (error) { if (epoch === authEpoch.current) { const failed: EmailEntry = { ...entry, phase: 'error', error: error instanceof ApiError && [403, 404].includes(error.status) ? 'This page is not available.' : 'Could not open this page. Try again.', sent: false }; emailEntryRef.current = failed; setEmailEntry(failed); } }
  }
  async function renewCurrentEmailLink() {
    const entry = emailEntryRef.current;
    if (!entry?.id) return;
    await perform(async () => { await (Platform.OS === 'web' ? renewEmailLink : renewNativeEmailLink)(API_URL, entry.id!); if (emailEntryRef.current?.id === entry.id) setEmailEntry({ ...entry, error: '', sent: true }); }, false).catch(() => { if (emailEntryRef.current?.id === entry.id) setEmailEntry({ ...entry, error: 'Could not send a new link. Try again.', sent: false }); });
  }
  function retryEmailLink() { const entry = emailEntryRef.current; if (entry) setEmailEntry({ ...entry, phase: 'opening', error: '', sent: false }); }
  function leaveEmailLink() {
    if (Platform.OS !== 'web' && session && !emailEntryRef.current?.target) setExpired(true);
    forgetEmailProof(); initialEmailLink.current = null; emailProof.current = null; emailEntryRef.current = null; setEmailEntry(null);
    authHeldRef.current = false; resumeAccountRequests(); queueCookieCheck();
  }
  const mascotEligible = online && isOnline() && !busy && !expired && !notice && !commands.length && !hasDrafts && !legacy.length && !recoveries.length && !unavailable.length && !returns.length;
  const direct = tab === 'Friends';
  const visibleGroups = groups.filter(row => direct ? !!session && visiblePeopleSummary(row.group, session.userId, commands.some(command => command.group_id === row.group.id)) : !row.group.is_direct);
  const title = screen === 'home' ? (tab === 'Friends' ? 'People' : tab === 'Account' ? 'Me' : tab) : screen === 'login' ? 'Sign in' : screen === 'create' ? (direct ? 'Add a person' : 'New group') : screen === 'expense' ? (expenseId ? 'Edit bill' : 'Add a bill') : screen === 'expenseDetail' ? expense?.description ?? 'Bill' : screen === 'settle' ? 'Payment' : screen === 'members' ? 'Group settings' : screen === 'review' ? 'Review your bill' : screen === 'paymentDetail' ? 'Payment record' : screen === 'import' ? 'Import from Splitwise' : selected?.group.name ?? 'Group';
  if (!ready) return <SafeAreaView style={[s.screen, s.loading]}><ActivityIndicator color={colors.accent} /><Text style={ui.caption}>Opening your groups…</Text></SafeAreaView>;
  if (storageError) return <SafeAreaView style={[s.screen, pageContentStyle]}><Text style={ui.section}>Could not open saved records</Text><Text accessibilityRole="alert" style={ui.error}>{storageError}</Text><Button title="Retry" disabled={busy} onPress={() => launch(restore)} /></SafeAreaView>;
  if (authHeld) return <EmailLinkScreen title={emailEntry?.phase === 'name' ? 'Name' : 'Sign in'} busy={busy}>
    {!checkingCookie && emailEntry?.phase === 'name' ? <NameOnlyForm key={emailEntry.id} busy={busy} onSave={finishEmailName} />
      : <EmailLinkStatus opening={checkingCookie || emailEntry?.phase === 'opening' || emailEntry?.phase === 'target'} busy={busy} error={emailEntry?.error ?? ''} sent={!!emailEntry?.sent} canRenew={!!emailEntry?.id} onRetry={retryEmailLink} onRenew={() => void renewCurrentEmailLink()} onSignIn={leaveEmailLink} />}
  </EmailLinkScreen>;
  return <AppFrame onTouchStart={notices.engage}>
    {screen === 'login' && !session && !challenge && !emailRequested && mascotEligible && <Mascot size="welcome" />}
    <ScreenHeader title={title} busy={busy} onBack={screen !== 'home' && (session || screen !== 'login') ? back : undefined}>
      {Platform.OS === 'web' && session && (screen === 'home' && tab !== 'Account' || screen === 'group') && <IconAction name="refresh" label="Refresh" disabled={busy} onPress={() => { if (screen === 'home' && tab === 'Activity') void refreshActivity().catch(() => {}); else launch(sync); }} />}
      {screen === 'group' && selected && <IconAction name="add" label="Add bill" disabled={busy || !!selected.group.archived} onPress={() => launch(() => openExpense())} />}
      {screen === 'group' && selected && <IconAction name="settings" label="Group settings" disabled={busy} onPress={() => navigate('members')} />}
      {screen === 'members' && selected && !selected.group.is_direct && !selected.group.archived && selected.group.participants.some(person => person.id === selfId && !person.removed && person.user_id === selected.group.owner_id) && <IconAction name="personAdd" label="Add person" disabled={busy} onPress={() => setAddPersonRequest(value => value + 1)} />}
    </ScreenHeader>
    <ScrollView ref={scroll} onLayout={measureViewport} onScroll={() => setScrollEpoch(value => value + 1)} scrollEventThrottle={100} key={`${owner}|${screen}|${groupId ?? ''}`} contentContainerStyle={pageContentStyle} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag"
      refreshControl={session && !expired && (screen === 'home' || screen === 'group') ? <RefreshControl refreshing={busy} tintColor={colors.accent} colors={[colors.accent]} onRefresh={() => { if (screen === 'home' && tab === 'Activity') void refreshActivity().catch(() => {}); else launch(() => sync()); }} /> : undefined}>
      {!!notice && <Text accessibilityLiveRegion="polite" accessibilityRole={feedback.tone === 'error' ? 'alert' : undefined} style={[ui.notice, feedback.tone === 'success' ? ui.success : feedback.tone === 'warning' ? ui.warning : feedback.tone === 'error' ? ui.error : undefined]}>{notice}</Text>}
      {expired && screen !== 'login' && <Button title="Sign in again" kind="primary" onPress={() => { setChallenge(null); setCode(''); navigate('login'); }} />}
      {screen === 'home' && (tab === 'Groups' || tab === 'Friends') && <>
        <GroupList emptyVerified={mascotEligible && !!owner && verifiedEmptyOwner === owner} groups={visibleGroups} commands={commands} userId={session?.userId} busy={busy} direct={direct} onOpen={row => launch(() => openGroup(row))} />
        <Button title={direct ? 'Add person' : 'New group'} icon="add" kind={!visibleGroups.length ? 'primary' : 'secondary'} disabled={busy} onPress={() => navigate('create')} />
        {!!(legacy.length || unavailable.length) && <Button title="Review saved work" kind="text" onPress={openMe} />}
      </>}
      {screen === 'home' && session && returns.filter(value => value.launch === 'opened' || value.decision !== null || value.launch === 'opening').slice(0, 1).map(value => <Button key={value.attemptId} title="Review payment" disabled={busy} onPress={() => launch(async () => { const group = await fetchGroup(session, value.groupId); await saveGroup(await getDatabase(), owner, group, 'shared'); setGroupId(group.id); setReturnAttemptId(value.attemptId); setTransfer({ sender: value.sender, recipient: value.recipient, amount: value.amount }); navigate('settle'); })} />)}
      {screen === 'create' && session && <CreateGroupForm direct={direct} busy={busy} onCreate={values => launch(() => createGroup(values))} />}
      {screen === 'group' && selected && preview && <>{!!previewError && <Text>{previewError}</Text>}<GroupScreen noticeVisibility={noticeVisibility} key={`${owner}|${groupId}`} group={preview} accepted={selected.group} pending={pending} durable={storageIsDurable()} busy={busy} selfId={selfId} onHistoryPage={(resource, direction, query) => { void historyPage(resource, direction, query).catch(() => {}); }} onConfirmReceipt={attempt => showAlert('Confirm receipt?', `Check your bank app for ${formatMoney(attempt.recorded_amount ?? attempt.amount)}. This acknowledges a record; it does not verify the bank transfer.`, [{ text: 'Cancel', style: 'cancel' }, { text: 'Received', onPress: () => { void groupAction(`/payment-attempts/${attempt.id}/confirm`, {}).catch(() => {}); } }])} onExpense={value => { void openBill(value).catch(() => {}); }} onPayment={value => { void openPayment(value.id).catch(() => {}); }} onSettle={value => { setReturnAttemptId(null); setTransfer(value); navigate('settle'); }} onReverse={value => confirm('Reverse payment record?', 'Balances will change. No bank transfer is reversed.', () => reversePayment(value))} onSync={() => launch(() => sync())} onReview={value => launch(() => reviewChange(value))} onDiscard={value => value.path === '/groups' ? confirm('Discard unsent group?', 'This removes unsent bills and drafts for this group. Already accepted records will return when connected.', async () => { await discardUnsentGroup(await getDatabase(), owner, value.group_id); setGroupId(null); navigate('home'); }) : confirm('Discard unsent change?', 'This removes your saved change. If it already reached the server, accepted records will remain.', async () => { await discardCommand(await getDatabase(), owner, value.command_id); })} /></>}
      {screen === 'expenseDetail' && selected && expense && <><ExpenseDetail noticeVisibility={noticeVisibility} selfId={selfId} expense={expense} group={selected.group} busy={busy} canEdit={!pending.length && !selected.group.archived} onEdit={() => launch(() => openExpense(expense))} onDelete={() => confirm('Delete expense?', 'Balances will update. You can restore this expense later.', () => changeExpense(expense))} onRestore={() => confirm('Restore expense?', 'Its original split will be added to balances once.', () => changeExpense(expense, true))} />
        {!expense.deleted && (!(selected.group.expenses.some(value => value.id === expense.id) || selected.group.focused_expense?.id === expense.id) ? <Text style={ui.caption}>Pending sync</Text> : <BillAttachments key={`${owner}|${groupId}|${expense.id}`} session={session} groupId={selected.group.id} expenseId={expense.id} revision={selected.group.version} readOnly={selected.group.archived || !!pending.length} busy={busy}
          onBusyChange={value => { lock.current = value; setBusy(value); }} onChanged={async () => { if (!session) return; const scope = accountOwner(session); const updated = await fetchGroup(session, selected.group.id); await saveGroup(await getDatabase(), scope, updated, 'shared'); await load(scope); }} />)}
      </>}
      {screen === 'expense' && selected && <ExpenseForm key={`${owner}|${groupId}|${expenseId ?? 'new'}`} group={expense && !selected.group.expenses.some(value => value.id === expense.id) ? { ...selected.group, expenses: [...selected.group.expenses, expense] } : selected.group} expense={reviewInput ?? expense} selfId={selfId} busy={busy} initialDraft={draft ?? undefined} onDraftChange={value => { setHasDrafts(true); const scope = owner, id = groupId!; draftWrites.current = draftWrites.current.then(async () => saveDraft(await getDatabase(), scope, id, value)).catch(error => setNotice(`Could not save draft: ${error.message}`, 'error')); }} onSave={saveExpense} onCancel={back} />}
      {screen === 'review' && selected && reviewCommand && <SavedChangeScreen command={reviewCommand} group={selected.group} busy={busy} onDiscard={() => confirm('Discard this unsent change?', 'Accepted records remain. Your saved change will be removed from this phone.', async () => { await discardCommand(await getDatabase(), owner, reviewCommand.command_id); setReviewCommand(null); navigate('group'); })} onEditSaved={value => { setReviewInput(value); setDraft(null); setExpenseId(reviewCommand.method === 'PUT' ? value.id : null); navigate('expense'); }} />}
      {screen === 'settle' && selected && preview && <SettleForm key={`${owner}|${groupId}`} group={preview} initial={transfer} busy={busy} selfId={selfId} onReviewAttempt={reviewPaymentAttempt} onPrepareUPI={prepareUPI} onCancelUPI={async id => { await groupAction(`/payment-attempts/${id}/cancel`, {}); await clearPaymentReturn(await getDatabase(), owner, id); await load(); }} returnPayment={returnPayment} onArmReturn={armPaymentReturn} onReturnPaymentChange={persistPaymentReturn} onResolveReturn={finishPaymentReturn} onSave={savePayment} onCancel={() => { setReturnAttemptId(null); back(); }} />}
      {screen === 'paymentDetail' && selected && settlement && <PaymentDetail payment={settlement} group={selected.group} selfId={selfId} busy={busy} canReverse={!pending.length && !selected.group.archived} onReverse={() => confirm('Reverse payment record?', 'Balances will change. No bank transfer is reversed.', () => reversePayment(settlement))} />}
      {screen === 'members' && selected && <MembersScreen key={`${owner}|${groupId}`} group={selected.group} selfId={selfId} busy={busy} onAction={groupAction} onExport={exportGroup} addPersonRequest={addPersonRequest} />}
      {screen === 'home' && tab === 'Activity' && session && <ActivityScreen emptyVerified={mascotEligible && activity?.firstPage === true && activityOwner.current === owner} items={activity?.items ?? []} busy={busy} error={activityError} hasMore={!!activity?.next_cursor} onRefresh={() => { void refreshActivity().catch(() => {}); }} onLoadMore={() => { void refreshActivity(true).catch(() => {}); }} onOpen={target => { void openActivityTarget(target).catch(() => {}); }} />}
      {screen === 'login' && <>
        {emailRequested ? <EmailLinkSent busy={busy} resendSeconds={Math.max(0, Math.ceil((retryAt - clock) / 1000))} onResend={() => launch(sendSignInLink)} onCode={() => setEmailRequested(false)} onChangeEmail={() => { setEmailRequested(false); setChallenge(null); setCode(''); }} />
          : !challenge ? <EmailSignIn email={email} busy={busy} onEmail={setEmail} sendLabel={Platform.OS === 'web' ? 'Email me a sign-in link' : undefined} onSend={() => launch(Platform.OS === 'web' ? sendSignInLink : sendSignInCode)}>
            {Platform.OS === 'web' && <Button title="Use a code instead" kind="text" disabled={busy} onPress={() => launch(sendSignInCode)} />}
          </EmailSignIn>
          : <CodeSignIn email={email} code={code} busy={busy} resendSeconds={Math.max(0, Math.ceil((retryAt - clock) / 1000))} onCode={setCode} onConfirm={() => launch(finishSignIn)} onResend={() => launch(sendSignInCode)} onChangeEmail={() => { setChallenge(null); setCode(''); }} />}
        <Button title="Help" kind="text" onPress={() => launch(() => Linking.openURL(`${API_URL}/support`))} />
      </>}
      {screen === 'import' && session && <SplitwiseImportScreen key={owner} session={session} busy={busy}
        onBusyChange={value => { lock.current = value; setBusy(value); }} onCancel={back}
        onImported={(group, alreadyImported) => { if (ownerRef.current !== accountOwner(session)) return; setGroups(rows => [...rows.filter(row => row.group.id !== group.id), { kind: 'shared', group }]); setGroupId(group.id); setExpenseId(null); setTab('Groups'); setScreen('group'); setNotice(alreadyImported ? 'Already imported.' : 'Imported.', 'success'); }} />}
      {screen === 'home' && tab === 'Account' && session && <>
        <AccountHeader key={owner} session={session} name={myName} busy={busy} onBusyChange={value => { lock.current = value; setBusy(value); }} />
        <View><ProfileSettings key={owner} name={myName} vpa={vpa} busy={busy} onSaveName={saveName} onSaveUPI={value => perform(async () => { const result = await request<{ vpa: string }>(session, '/me/payment-profile', 'PUT', { vpa: value }); setVpa(result.vpa); }, false)} onAppearance={value => perform(() => changeAppearance(value), false)} />
          <AccountNotifications key={owner} session={session} push={push} busy={busy} onBusyChange={value => { lock.current = value; setBusy(value); }} />
        <View><SettingsRow label="Import from Splitwise" icon="import" disabled={busy} onPress={() => navigate('import')} />
          <SettingsRow label="Export account" icon="export" disabled={busy} onPress={() => launch(async () => { await shareJson('merosplit-account', await request(session, '/account/export')); })} /></View>
        <Disclosure title="Saved changes and recovery"><Button title="Export saved changes and recovery records" disabled={busy} onPress={() => launch(exportSaved)} /></Disclosure>
        {!!unavailable.length && <Text style={[ui.notice, ui.warning]}>Access to {unavailable.length === 1 ? 'a group has' : 'some groups have'} ended. Saved work is kept for export.</Text>}
        <SavedChanges commands={commands} groups={groups} busy={busy} expired={expired} onOpen={row => launch(() => openGroup(row))} onDiscard={value => confirm('Discard saved change?', 'Export first if needed. This removes only your unsent change. A request already accepted by the server is kept there.', async () => { await discardCommand(await getDatabase(), owner, value.command_id); })} onRetry={() => launch(sync)} />
        <LegacyRecords groups={legacy} email={session.email} selected={legacySelf} busy={busy} onSelect={(id, person) => setLegacySelf(value => ({ ...value, [id]: person }))}
          onRecover={group => confirm('Recover to this account?', `${group.name} will be linked to ${session.email}. Original history is kept in recovery records.`, async () => {
            const result = await claimLegacyGroup(await getDatabase(), session, group.id, legacySelf[group.id], uuid);
            await load();
            if (result.status === 'conflict') { setNotice('These records need review. Their original copy is saved for export; server balances were not changed.', 'warning'); return; }
            await syncAccount(session); setGroupId(group.id); setScreen('group'); setNotice('Records recovered.', 'success');
          })}
          onExport={group => launch(async () => { const db = await getDatabase(); await shareJson('merosplit-earlier-records', { group, draft: await readDraft(db, 'local', group.id), pending_commands: (await pendingCommands(db, 'local')).filter(value => value.group_id === group.id) }); })} />
        {recoveries.some(value => value.status === 'conflict') && <Text style={[ui.notice, ui.warning]}>Some earlier records could not be safely combined. Export recovery records to review them.</Text>}
        <View><SettingsRow label="Privacy" icon="privacy" disabled={busy} onPress={() => launch(() => Linking.openURL(`${API_URL}/privacy`))} /><SettingsRow label="Help and support" icon="help" disabled={busy} onPress={() => launch(() => Linking.openURL(`${API_URL}/support`))} /></View>
        <View>

          <SettingsRow label="Sign out" icon="back" chevron={false} disabled={busy} onPress={() => confirm('Sign out?', storageIsDurable() ? 'Saved changes stay on this device for your next sign-in to this account.' : 'Export any temporary unsent changes before leaving. They will end when this tab closes.', async () => { await draftWrites.current; await endPushSession(session); await clearMediaPreviews(); await saveSession(null); changeScope(null); })} />
          <SettingsRow label="Delete account" icon="remove" danger chevron={false} disabled={busy} onPress={() => confirm('Delete account?', 'Export first. Your account, uploads and text you added will be removed. Other members keep anonymous amounts and payment history. Unsent changes for this account will be deleted from this phone.', async () => { await push.disable().catch(() => {}); await request(session, '/account', 'DELETE'); await push.clear(); setPushTarget(null); await draftWrites.current; const db = await getDatabase(); await clearAccountMediaUploads(db, session); await wipeAccount(db, owner); await clearMediaPreviews(); await saveSession(null); changeScope(null); })} />
        </View></View>
      </>}
    </ScrollView>
    {screen === 'home' && session && <AppTabs selected={tab} busy={busy} onSelect={value => { if (value === 'Activity') { activityOwner.current = ''; setActivityError(''); } setTab(value); setNotice(''); }} />}
  </AppFrame>;
}
export default function App() { return <SafeAreaProvider><UIProvider><AppContent /></UIProvider></SafeAreaProvider>; }
const makeStyles = (colors: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background }, loading: { alignItems: 'center', justifyContent: 'center', gap: 14 },
});
