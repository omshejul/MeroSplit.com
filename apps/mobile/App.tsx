import { PhotoSession } from './src/Avatar';
import { readPrefetch, readScope } from './src/prefetch';
import { personalTransfers } from './src/personalBalances';
import { subscribeConnection } from './src/connectivity';
import SyncStatus from './src/SyncStatus';
import { usePullToRefresh } from './src/usePullToRefresh';
import SceneTransition from './src/SceneTransition';
import AppStack, { NavigationContainer, useAppNavigation, webLinking } from './src/AppStack';
import type { AppRoute, RouteParams, Screen } from './src/routes';
import MotionReveal from './src/MotionReveal';
import { loadBalanceSource } from './src/balanceExplanationStorage';
import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, BackHandler, Linking, Platform, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import type { AlertButton } from 'react-native';
import { Alert } from './src/alerts';
import { SafeAreaProvider, SafeAreaView, initialWindowMetrics } from 'react-native-safe-area-context';
import * as Crypto from 'expo-crypto';
import { accountOwner, ApiError, requestEmailCode, confirmEmailCode, endSession, claimLegacyGroup, expensePayload, fetchGroup, refreshGroups, request, syncOutbox, cacheOfflineGroups, prefetchRead } from './src/api';
import type { EmailCodeChallenge } from './src/api';
import { readAppLink, type AppLink } from './src/browserLinks';
import { validateUPIPayment, type UPILaunchQuote } from './src/upi';
import { formatMoney } from './src/accounting';
import { emptyGroup, previewPending } from './src/ledger';
import { getDatabase, savedSession, saveSession, retireSyncPause, shareJson, storageIsDurable, isOnline, claimFirstSplitUPIPrompt } from './src/native';
import { storageRevision, discardCommand, discardUnsentGroup, enqueue, enqueueBill, confirmedSync, confirmSync, readGroup, listGroups, pendingCommands, createPendingGroup, listLegacyGroups, listLegacyRecoveries, listUnavailableGroups, replaceCommand, saveGroup, readVisibleGroup, wipeAccount } from './src/storage';
import GroupScreen, { ExpenseDetail, PaymentDetail } from './src/GroupScreen';
import ExpenseForm from './src/ExpenseForm';
import ExpenseVersionHistory from './src/ExpenseVersionHistory';
import SettleForm from './src/SettleForm';
import ActivityScreen from './src/ActivityScreen';
import ChatInbox from './src/ChatInbox';
import { createPaymentReturn } from './src/paymentReturn';
import type { PaymentReturn } from './src/paymentReturn';
import { listPaymentReturns, savePaymentReturn, clearPaymentReturn, resolvePaymentReturn } from './src/paymentReturnStorage';
import MembersScreen from './src/MembersScreen';
import SendInviteDialog from './src/SendInviteDialog';
import GroupJoinDialog from './src/GroupJoinDialog';
import { savedGroupInvite, saveGroupInvite } from './src/groupInviteStore';
import { groupInviteToken } from './src/groupInvite';
import { forgetGroupInvite } from './src/groupInvite';
import FeedbackDialog from './src/FeedbackDialog';
import UPISetupDialog from './src/UPISetupDialog';
import { sendInvitation } from './src/members';
import SavedChangeScreen from './src/SavedChangeScreen';
import SplitwiseImportScreen from './src/SplitwiseImportScreen';
import AccountHeader from './src/AccountHeader';
import GroupList from './src/GroupList';
import { groupListRows } from './src/groupListRows';
import Mascot from './src/Mascot';
import { AddExpenseButton, AppFrame, pageContentStyle, ScreenHeader } from './src/AppNavigation';
import HomeTabs, { usesNativeHomeTabs } from './src/HomeTabs';
import { EmailSignIn, CodeSignIn } from './src/SignInForms';
import SignInLayout from './src/SignInLayout';
import GoogleSignInButton from './src/GoogleSignInButton';
import { useLinkedProviders } from './src/useLinkedProviders';
import AppleSignInButton from './src/AppleSignInButton';
import { googleBrowserError, type GoogleAuthenticate, type GoogleProcess } from './src/googleSignIn';
import { captureEmailLink, forgetEmailProof, subscribeEmailLinks, type EmailLink, type EmailTarget, type EmailLinkInspection } from './src/emailLink';
import { inspectEmailLink, resolveEmailLink, renewEmailLink, requestEmailLink, EmailLinkError } from './src/emailLinkApi';
import { inspectNativeEmailLink, resolveNativeEmailLink, renewNativeEmailLink, NativeEmailLinkError } from './src/nativeEmailLinkApi';
import SwitchAccountDialog from './src/SwitchAccountDialog';
import { APP_ORIGIN, startNativeLinks } from './src/appLinks';
import { pauseAccountRequests, resumeAccountRequests } from './src/accountRequests';
import { readBrowserSession, updateBrowserSessionMetadata } from './src/browserAuth';
import { EmailLinkDialog, EmailLinkScreen, EmailLinkStatus, EmailLinkSent, NameOnlyForm } from './src/EmailLinkScreens';
import CreateGroupForm from './src/CreateGroupForm';
import type { NewGroupValues } from './src/CreateGroupForm';
import { SavedChanges, LegacyRecovery as LegacyRecords } from './src/AccountRecovery';
import ProfileSettings from './src/ProfileSettings';
import SignInMethods from './src/SignInMethods';
import AppUpdates from './src/AppUpdates';
import { restartForUpdate } from './src/appUpdate';
import { usePushNotifications } from './src/PushSettings';
import AccountNotifications from './src/AccountNotifications';
import MCPSettings from './src/MCPSettings';
import OAuthContinuation from './src/OAuthContinuation';
import { changeGroupMembership } from './src/groupMembership';
import type { PushTarget } from './src/notifications';
import BillAttachments from './src/BillAttachments';
import BillChatScreen, { BillChatEntry } from './src/BillChatScreen';
import { flushChatWrites } from './src/billChat';
import DeleteAccount from './src/DeleteAccount';
import { portableExport } from './src/portableExport';
import { accountDeletionInput } from './src/accountDeletion';
import ExportData from './src/ExportData';
import { clearAccountMediaUploads, clearMediaPreviews, enqueueExpenseWithMedia, retryAccountMediaUploads, type PendingMediaUpload } from './src/media';
import type { CachedGroup, Command, Expense, Group, LegacyRecovery, Session, Settlement, HistoryResource, ActivityPage, ActivityTarget, BillRow } from './src/types';
import { Button, IconAction, SettingsRow, UIProvider, useUI, type Palette } from './src/ui';
import { groupDisplayName, visiblePeopleSummary } from './src/personalBalances';
import { useExpenseIcons } from './src/useExpenseIcons';
import type { ExpenseIconRef } from './src/categoryIcons';
import { useExpenseNotices } from './src/useExpenseNotices';
import type { WindowFrame } from './src/expenseNotices';
import { Text } from 'react-native-paper';

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? (Platform.OS === 'web' ? window.location.origin : APP_ORIGIN);
const uuid = () => Crypto.randomUUID();
type Transfer = { sender: string; recipient: string; amount: string };
type EmailEntry = { id: string | null; phase: 'opening' | 'switch' | 'target' | 'name' | 'error'; error: string; sent: boolean; target?: EmailTarget; inspection?: EmailLinkInspection; switchFromUserId?: number };
function AppContent() {
  const { palette: colors, ui, changeAppearance, changeColorFamily } = useUI();
  const s = makeStyles(colors);
  const [session, setSession] = useState<Session | null>(null), [ready, setReady] = useState(false), [expired, setExpired] = useState(false);
  const [storageError, setStorageError] = useState(''), [hasDrafts, setHasDrafts] = useState(false);
  const [verifiedEmptyOwner, setVerifiedEmptyOwner] = useState(''), [emptyChatScope, setEmptyChatScope] = useState('');
  const [online, setOnline] = useState(isOnline);
  const [lastConfirmed, setLastConfirmed] = useState<string | null>(null), [syncProblem, setSyncProblem] = useState(false), [syncing, setSyncing] = useState(false), [pendingFiles, setPendingFiles] = useState(0), [downloadingOwner, setDownloadingOwner] = useState('');
  const offlineDownload = useRef<Promise<void> | null>(null);
  const [groups, setGroups] = useState<CachedGroup[]>([]), [commands, setCommands] = useState<Command[]>([]);
  const [showArchived, setShowArchived] = useState(false), [showHidden, setShowHidden] = useState(false);
  const [needsInvitation, setNeedsInvitation] = useState(false);
  const navigation = useAppNavigation(), { name: screen, params: routeParams = {} } = navigation.route;
  const { tab = 'Groups', groupId = null, expenseId = null, settlementId = null } = routeParams;
  const [navigationScope, setNavigationScope] = useState(0), initialScreen = useRef<Screen>('login');
  const [transfer, setTransfer] = useState<Transfer | undefined>();
  const [reviewCommand, setReviewCommand] = useState<Command | null>(null), [reviewInput, setReviewInput] = useState<Expense | undefined>();
  const methodsRow = useRef<React.ComponentRef<typeof View>>(null);
  const googleReturn = useRef(Platform.OS === 'web' ? new URLSearchParams(window.location.search).get('google_return') : null);
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const url = new URL(window.location.href);
    if (!url.searchParams.has('google_error') && !url.searchParams.has('google_return')) return;
    url.searchParams.delete('google_error'); url.searchParams.delete('google_return');
    window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
  }, []);
  const [busyRoutes, setBusyRoutes] = useState<string[]>([]), [pulling, setPulling] = useState(false), [feedback, setFeedback] = useState(() => ({ text: Platform.OS === 'web' ? googleBrowserError(window.location.search) : '', tone: 'error' as 'info' | 'success' | 'warning' | 'error' }));
  const submissions = useRef(new Set<string>()), busy = busyRoutes.length > 0;
  const [reading, setReading] = useState(0);
  const opening = useRef<object | null>(null);
  const openRequests = useRef(new Map<string, { route: unknown; promise: Promise<unknown> }>());
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const notice = feedback.text;
  const setNotice = (text: string, tone: typeof feedback.tone = 'info') => setFeedback({ text, tone });
  const [email, setEmail] = useState(''), [code, setCode] = useState(''), [challenge, setChallenge] = useState<EmailCodeChallenge | null>(null), [retryAt, setRetryAt] = useState(0), [clock, setClock] = useState(Date.now());
  const [appLink, setAppLink] = useState<AppLink | null>(readAppLink);
  const resolvedRoute = useRef('');
  const initialEmailLink = useRef(Platform.OS === 'web' ? captureEmailLink() : null), emailProof = useRef(initialEmailLink.current);
  const [emailEntry, setEmailEntry] = useState<EmailEntry | null>(() => initialEmailLink.current ? { id: initialEmailLink.current.id, phase: 'opening', error: '', sent: false } : null);
  const emailEntryRef = useRef(emailEntry); emailEntryRef.current = emailEntry;
  const [emailRequested, setEmailRequested] = useState(false), [checkingCookie, setCheckingCookie] = useState(false);
  const [nativeLinksReady, setNativeLinksReady] = useState(Platform.OS === 'web');
  const authEpoch = useRef(0), cookieCheck = useRef(false), validatedBrowserSession = useRef('');
  const authHeld = !nativeLinksReady || !!emailEntry || checkingCookie, authHeldRef = useRef(authHeld); authHeldRef.current = authHeld;
  const protectedContent = useRef<React.ComponentRef<typeof View>>(null);
  useEffect(() => {
    if (Platform.OS === 'web' && protectedContent.current) (protectedContent.current as unknown as HTMLElement).inert = authHeld;
  }, [authHeld, !!session]);
  const authPending = !nativeLinksReady || checkingCookie || emailEntry?.phase === 'opening' || emailEntry?.phase === 'switch' || emailEntry?.phase === 'error';
  const [myName, setMyName] = useState('You');
  const [addPersonRequest, setAddPersonRequest] = useState(0);
  const [newPersonInvite, setNewPersonInvite] = useState<{ owner: string; groupId: string; personId: string; email: string; id: string } | null>(null), [newPersonInviteError, setNewPersonInviteError] = useState('');
  const [foreground, setForeground] = useState(AppState.currentState === 'active' && (Platform.OS !== 'web' || document.visibilityState === 'visible'));
  const scroll = useRef<React.ComponentRef<typeof ScrollView>>(null), suppressPush = useRef<(data: unknown) => boolean>(() => false);
  const [viewport, setViewport] = useState<WindowFrame | null>(null), [scrollEpoch, setScrollEpoch] = useState(0);
  const [alertOpen, setAlertOpen] = useState(false);
  const [vpa, setVpa] = useState(''), [upiSetup, setUpiSetup] = useState(false), [upiAfterSplit, setUpiAfterSplit] = useState(false);
  const upiPrompts = useRef(new Set<string>());
  const profileRevision = useRef(0);
  const [returnAttemptId, setReturnAttemptId] = useState<string | null>(null);
  const [returns, setReturns] = useState<PaymentReturn[]>([]);
  const [activity, setActivity] = useState<(ActivityPage & { firstPage: boolean }) | null>(null), [activityError, setActivityError] = useState('');
  const activityOwner = useRef(''), groupVersions = useRef('');
  const [legacy, setLegacy] = useState<Group[]>([]), [recoveries, setRecoveries] = useState<LegacyRecovery[]>([]), [unavailable, setUnavailable] = useState<Group[]>([]);
  const [legacySelf, setLegacySelf] = useState<Record<string, string>>({});
  const scopeGeneration = useRef(0);
  const owner = session ? accountOwner(session) : '', ownerRef = useRef(owner); ownerRef.current = owner;
  const deferredSync = useRef(false);
  const lock = useRef(false), draftWrites = useRef(Promise.resolve()), activeSessionRef = useRef(session); activeSessionRef.current = authPending ? null : session;
  const [pushTarget, setPushTarget] = useState<{ token: string; target: PushTarget | null } | null>(null);
  const push = usePushNotifications(authPending ? null : session, {
    onOpen: async target => { if (session) setPushTarget({ token: session.token, target }); },
    onForeground: async () => { if (ready && session && !authHeldRef.current && !lock.current) syncQuietly(); },
    shouldSuppress: data => suppressPush.current(data),
  });
  const providerConnections = useLinkedProviders(authPending ? null : session, ready && foreground && online && !expired && !authHeld);
  useEffect(() => { if (session && screen === 'signInMethods') providerConnections.refresh(); }, [session?.token, screen, tab]);
  const activeGroupRef = useRef(groupId); activeGroupRef.current = groupId;
  const selected = groups.find(row => row.group.id === groupId) ?? null;
  const browseScope = `${owner}|${session?.token}|${screen}|${tab}|${groupId}|${foreground}|${expired}|${authHeld}|${online}|${groupVersions.current}|${selected?.group.version}|${selected?.group.history?.transactions?.query ?? selected?.group.history?.bills?.query ?? ''}`;
  const browseCurrent = useRef(browseScope); browseCurrent.current = browseScope;
  const [ledgerRevision, setLedgerRevision] = useState(0), [ledgerUpdates, setLedgerUpdates] = useState(false);
  useEffect(() => { setLedgerUpdates(false); }, [owner, groupId]);
  const [visibleBills, setVisibleBills] = useState<{ scope: string; ids: string[] }>({ scope: '', ids: [] });
  const [visibleActivity, setVisibleActivity] = useState<{ scope: string; refs: ExpenseIconRef[] }>({ scope: '', refs: [] });
  const pending = commands.filter(command => command.group_id === groupId);
  const selfId = selected?.group.participants.find(person => session && !person.removed && String(person.user_id) === session.userId)?.id ?? '';
  let preview = selected?.group ?? null, previewError = '';
  if (preview && pending.length) { try { preview = previewPending(preview, pending); } catch (error) { previewError = error instanceof Error ? error.message : 'Sync to review saved changes.'; } }
  const expense = preview?.expenses.find(value => value.id === expenseId) ?? (preview?.focused_expense?.id === expenseId ? preview.focused_expense : undefined);
  const accepted = selected?.group;
  const iconRefs: ExpenseIconRef[] = [];
  if (screen === 'group' && accepted && !accepted.hidden && !pending.length && visibleBills.scope === `${owner}|${groupId}`) {
    for (const id of visibleBills.ids.slice(0, 20)) {
      const bill = accepted.transactions?.find(row => row.kind === 'bill' && row.bill.id === id);
      const value = accepted.expenses.find(value => value.id === id) ?? (bill?.kind === 'bill' ? bill.bill : undefined);
      if (value && !value.deleted) iconRefs.push({ ...value, groupId: accepted.id, title: value.description });
    }
  } else if (screen === 'expenseDetail' && accepted && !accepted.hidden && !pending.length) {
    const value = accepted.expenses.find(value => value.id === expenseId) ?? (accepted.focused_expense?.id === expenseId ? accepted.focused_expense : undefined);
    if (value && !value.deleted) iconRefs.push({ ...value, groupId: accepted.id, title: value.description });
  } else if (screen === 'home' && tab === 'Activity' && activityOwner.current === owner && visibleActivity.scope === `${owner}|${session?.token}`) {
    // Resolve visible IDs against the current accepted feed, never a prior callback's title or mode.
    for (const ref of visibleActivity.refs.slice(0, 20)) {
      const row = activity?.items.find(row => row.bill?.id === ref.id && row.group.id === ref.groupId);
      if (row?.bill && !row.bill.deleted) iconRefs.push({ ...row.bill, groupId: row.group.id, title: row.bill.description });
    }
  }
  const categoryIcons = useExpenseIcons(session, iconRefs, ready && foreground && !expired && !authHeld, online);
  const returnPayment = returns.find(value => value.groupId === groupId && value.attemptId === returnAttemptId) ?? null;
  const settlement = preview?.settlements.find(value => value.id === settlementId) ?? (preview?.focused_settlement?.id === settlementId ? preview.focused_settlement : undefined);
  const inviteGroup = groups.find(row => row.group.id === newPersonInvite?.groupId)?.group;
  const invitePerson = inviteGroup?.participants.find(person => person.id === newPersonInvite?.personId);
  const showNewPersonInvite = !!newPersonInvite && newPersonInvite.owner === owner && !!inviteGroup && inviteGroup.version > 0 && !!invitePerson && !invitePerson.user_id && !commands.some(value => value.group_id === inviteGroup.id && value.path === '/groups');
  useEffect(() => {
    if (newPersonInvite && (newPersonInvite.owner !== owner || invitePerson?.user_id)) { setNewPersonInvite(null); setNewPersonInviteError(''); }
  }, [owner, newPersonInvite, invitePerson?.user_id]);
  const notices = useExpenseNotices(session, { enabled: ready && foreground && online && !expired && !authHeld, scope: `${screen}|${groupId}`, visibleExpenseIds: screen === 'group' ? visibleBills.scope === `${owner}|${groupId}` ? visibleBills.ids : [] : screen === 'expenseDetail' && expense ? [expense.id] : [],
    onRefresh: async ids => { if (authHeldRef.current || !session || activeSessionRef.current?.token !== session.token) return; await syncAccount(session, ids); } });
  suppressPush.current = notices.shouldSuppress;
  const updateSafe = useRef(false);
  const profilePromptSafe = useRef(false);
  profilePromptSafe.current = screen === 'home' && tab === 'Groups' && !feedbackOpen && !alertOpen && !appLink && !newPersonInvite && !upiSetup;
  updateSafe.current = ready && !!session && !expired && !authHeld && foreground && screen === 'home' && tab === 'Account'
    && !busy && !reading && !pulling && !storageError && !appLink && !emailEntry && !feedbackOpen && !alertOpen && !upiSetup
    && !returnAttemptId && !returns.length && !reviewCommand && !newPersonInvite && !pushTarget;
  async function restartUpdate(reload: () => Promise<void>) {
    const active = activeSessionRef.current, epoch = authEpoch.current;
    await restartForUpdate({ lock, reload,
      safe: () => updateSafe.current && AppState.currentState === 'active' && !authHeldRef.current
        && !!active && activeSessionRef.current?.token === active.token && authEpoch.current === epoch,
      flushWrites: async () => { await draftWrites.current; await flushChatWrites(accountOwner(active!)); },
    });
  }
  function engage() { opening.current = null; ++profileRevision.current; notices.engage(); }
  function measureViewport() { scroll.current?.measureInWindow((x, y, width, height) => setViewport({ x, y, width, height })); }
  function navigate(value: Screen, params?: RouteParams) { setNotice(''); navigation.go(value, params); }
  function changeScope(value: Session | null) {
    ++scopeGeneration.current;
    setFeedbackOpen(false); setUpiSetup(false); setUpiAfterSplit(false);
    if (!value && session) { forgetGroupInvite(); void saveGroupInvite(null).catch(() => {}); setAppLink(null); }
    setVerifiedEmptyOwner(''); setEmptyChatScope('');
    ownerRef.current = value ? accountOwner(value) : '';
    activeSessionRef.current = value;
    publishedStorage.current = { scope: '', view: '', changes: '' }; loadGeneration.current++;
    setShowArchived(false); setShowHidden(false); setNeedsInvitation(false); setSession(value); setExpired(false); setGroups([]); setCommands([]); setLegacy([]); setRecoveries([]); setUnavailable([]); setLegacySelf({});
    setVpa(''); setLastConfirmed(null); setSyncProblem(false); setSyncing(false); setPendingFiles(0); setDownloadingOwner('');
    initialScreen.current = value ? googleReturn.current === 'connect' ? 'signInMethods' : 'home' : 'login';
    setNavigationScope(scope => scope + 1); googleReturn.current = null;
    setMyName(value?.displayName || value?.email.split('@')[0] || 'You');
    setReviewCommand(null); setReviewInput(undefined); setReturns([]); setReturnAttemptId(null); setActivity(null); setActivityError(''); activityOwner.current = ''; groupVersions.current = '';
    void load(ownerRef.current).catch(error => setNotice(error.message, 'error'));
  }
  const publishedStorage = useRef({ scope: '', view: '', changes: '' });
  const loadGeneration = useRef(0);
  async function publishIfChanged() {
    const db = await getDatabase(), revision = await storageRevision(db);
    if (publishedStorage.current.scope !== ownerRef.current || publishedStorage.current.changes !== revision) await load();
  }
  async function load(scope = ownerRef.current) {
    if (!scope) return;
    const db = await getDatabase(), revision = await storageRevision(db);
    const view = `${isOnline()}|${activeGroupRef.current}`;
    if (publishedStorage.current.scope === scope && publishedStorage.current.view === view && publishedStorage.current.changes === revision) return;
    const generation = ++loadGeneration.current;
    const [rows, queue, older, backups, hidden, draftCount, savedReturns] = await Promise.all([listGroups(db, scope), pendingCommands(db, scope), listLegacyGroups(db), listLegacyRecoveries(db, scope), listUnavailableGroups(db, scope), db.getFirstAsync<{ n: number }>('SELECT count(*) AS n FROM drafts WHERE owner=? AND body<>?', scope, 'null'), listPaymentReturns(db, scope)]);
    if (ownerRef.current === scope) {
      const full = !isOnline() && activeGroupRef.current ? await readGroup(db, scope, activeGroupRef.current) : null;
      if (ownerRef.current !== scope || generation !== loadGeneration.current) return;
      if (full?.kind === 'shared') { const index = rows.findIndex(row => row.group.id === full.group.id && row.group.version === full.group.version); if (index >= 0) rows[index] = full; }
      const confirmed = await confirmedSync(db, scope);
      if (ownerRef.current !== scope || generation !== loadGeneration.current) return;
      setLastConfirmed(confirmed);
      const media = await db.getFirstAsync<{ n: number }>("SELECT count(*) AS n FROM drafts WHERE owner=? AND group_id LIKE 'media-upload:%' AND body<>?", scope, 'null');
      if (ownerRef.current !== scope || generation !== loadGeneration.current) return;
      setPendingFiles(media?.n ?? 0);
      const versions = rows.map(row => `${row.group.id}:${row.group.version}`).sort().join('|');
      if (groupVersions.current !== versions) {
        const ids = new Set(rows.map(row => row.group.id));
        if (groupVersions.current.split('|').some(value => value && !ids.has(value.split(':')[0]))) setActivity(null);
        groupVersions.current = versions; activityOwner.current = '';
      }
      if (generation !== loadGeneration.current) return;
      const same = <T,>(a: T, b: T): boolean => JSON.stringify(a) === JSON.stringify(b);
      setGroups(previous => {
        const stable = rows.map(row => previous.find(old => old.group.id === row.group.id && same(old, row)) ?? row);
        return stable.length === previous.length && stable.every((row, i) => row === previous[i]) ? previous : stable;
      });
      setCommands(previous => same(previous, queue) ? previous : queue);
      setLegacy(previous => same(previous, older) ? previous : older); setRecoveries(previous => same(previous, backups) ? previous : backups);
      setUnavailable(previous => same(previous, hidden) ? previous : hidden); setHasDrafts(!!draftCount?.n); setReturns(previous => same(previous, savedReturns) ? previous : savedReturns);
      publishedStorage.current = { scope, view, changes: revision };
    }
  }
  function setSubmission(value: boolean, key: string) {
    if (value) submissions.current.add(key); else submissions.current.delete(key);
    lock.current = submissions.current.size > 0; setBusyRoutes([...submissions.current]);
  }
  async function perform<T,>(action: () => Promise<T>, reportError = true, actionKey?: string): Promise<T> {
    const route = navigation.ref.getCurrentRoute()?.key ?? 'initial';
    const key = actionKey ? `${route}|${actionKey}` : route;
    if (submissions.current.has(key) || submissions.current.has(`${route}|attachments`) || lock.current && !submissions.current.size) throw new Error('Please wait for the current action.');
    const active = activeSessionRef.current;
    setSubmission(true, key); setNotice('');
    try { return await action(); }
    catch (error) { if (activeSessionRef.current?.token === active?.token) { const expired = error instanceof ApiError && error.status === 401; if (expired) setExpired(true); if (navigation.ref.getCurrentRoute()?.key === route && (reportError || expired)) setNotice(expired ? 'Sign in again to continue. Your saved changes are safe.' : error instanceof Error ? error.message : 'Could not save. Please try again.', 'error'); } throw error; }
    finally { await publishIfChanged().catch(() => {}); setSubmission(false, key); }
  }
  // Reads can finish in the background without owning a form's submission lock.
  async function background<T>(action: () => Promise<T>, reportError: boolean | (() => boolean) = true): Promise<T> {
    const active = session, route = navigation.ref.getRootState(), generation = scopeGeneration.current;
    setReading(value => value + 1);
    try { return await action(); }
    catch (error) {
      if (scopeGeneration.current === generation && activeSessionRef.current?.token === active?.token) {
        const expired = error instanceof ApiError && error.status === 401;
        if (expired) setExpired(true);
        if (navigation.ref.getRootState() === route && ((typeof reportError === 'function' ? reportError() : reportError) || expired)) setNotice(expired ? 'Sign in again to continue. Your saved changes are safe.' : error instanceof Error ? error.message : 'Could not load. Try again.', 'error');
      }
      throw error;
    } finally { await publishIfChanged().catch(() => {}); setReading(value => value - 1); }
  }
  // Coalesce repeated taps and let only the latest target open its destination.
  async function browse<T>(key: string, action: (current: () => boolean) => Promise<T>, reportError = true): Promise<T> {
    const active = session, context = browseCurrent.current, route = navigation.ref.getRootState(), generation = scopeGeneration.current;
    if (activeSessionRef.current?.token !== active?.token || authHeldRef.current) throw new Error('This account changed. Reopen the screen.');
    const identity = `${generation}|${active?.token}|${context}|${key}`;
    const existing = openRequests.current.get(identity);
    if (existing && existing.route === route) { opening.current = existing; return existing.promise as Promise<T>; }
    const entry = { route, promise: Promise.resolve() as Promise<unknown> };
    opening.current = entry;
    openRequests.current.set(identity, entry);
    const current = () => scopeGeneration.current === generation && opening.current === entry && activeSessionRef.current?.token === active?.token && !authHeldRef.current && navigation.ref.getRootState() === route;
    const promise = background(() => action(current), () => reportError && current()); entry.promise = promise;
    try { return await promise; } finally { if (opening.current === entry) opening.current = null; if (openRequests.current.get(identity) === entry) openRequests.current.delete(identity); }
  }
  const launch = (action: () => Promise<unknown>) => { void perform(action).catch(() => {}); };
  const open = (action: () => Promise<unknown>) => { void action().catch(() => {}); };
  const syncQuietly = () => { void background(sync, false).catch(() => {}); };
  // Only a user's own pull shows the native refresh spinner; background work uses the header.
  function pullToRefresh() {
    setPulling(true);
    const refresh = screen === 'home' && tab === 'Activity' ? refreshActivity(false, undefined, true) : background(sync, false);
    const scope = `${owner}|${groupId}`;
    void refresh.then(() => { if (`${ownerRef.current}|${activeGroupRef.current}` === scope) setLedgerRevision(value => value + 1); }).catch(() => {}).finally(() => setPulling(false));
  }
  usePullToRefresh(!!session && !expired && !authHeld && !busy && (screen === 'home' || screen === 'group'), pullToRefresh);
  function showAlert(title: string, message: string, buttons: AlertButton[]) {
    setAlertOpen(true);
    const close = () => setAlertOpen(false);
    Alert.alert(title, message, buttons.map(button => ({ ...button, onPress: () => { close(); button.onPress?.(); } })), { cancelable: true, onDismiss: close });
  }
  function confirm(title: string, message: string, action: () => Promise<unknown>) {
    showAlert(title, message, [{ text: 'Cancel', style: 'cancel' }, { text: 'Confirm', onPress: () => launch(action) }]);
  }
  // Only an explicit profile save rewrites native credentials under its write lock.
  async function rememberName(active: Session, displayName: string, persist = true) {
    const current = () => ownerRef.current === accountOwner(active) && activeSessionRef.current?.token === active.token;
    if (!current()) return;
    if (activeSessionRef.current?.displayName !== displayName) {
      const updated = { ...active, displayName };
      if (Platform.OS === 'web') { if (!updateBrowserSessionMetadata(active, updated)) return; } else if (persist) await saveSession(updated);
      if (current()) { activeSessionRef.current = updated; setSession(updated); }
    }
    if (current()) setMyName(displayName || active.email.split('@')[0] || 'You');
  }
  async function readProfile(active: Session) {
    const route = navigation.ref.getRootState(), revision = ++profileRevision.current;
    const me = await request<{ display_name?: string; payment_profile: { vpa: string } | null }>(active, '/me');
    if (revision !== profileRevision.current) return me;
    await rememberName(active, me.display_name ?? active.displayName ?? '', false);
    if (revision === profileRevision.current && activeSessionRef.current?.token === active.token && ownerRef.current === accountOwner(active)) {
      setVpa(me.payment_profile?.vpa ?? '');
      const key = `${accountOwner(active)}|${active.token}`;
      if (!me.payment_profile?.vpa && navigation.ref.getRootState() === route && profilePromptSafe.current && !upiPrompts.current.has(key)) { upiPrompts.current.add(key); setUpiSetup(true); }
    }
    return me;
  }
  async function saveName(display_name: string, onlyIfUnnamed = false) {
    await perform(async () => {
      if (!session) throw new Error('Sign in to continue.');
      ++profileRevision.current;
      const active = session, result = await request<{ display_name: string }>(active, '/me/profile', 'PUT', { display_name, ...(onlyIfUnnamed ? { only_if_unnamed: true } : {}) });
      if (typeof result.display_name !== 'string' || !result.display_name.trim()) throw new Error('Could not confirm the saved name. Try again.');
      ++profileRevision.current; await rememberName(active, result.display_name);
      try { await refreshGroups(await getDatabase(), active, 'summary'); await load(accountOwner(active)); }
      catch { setNotice('Name saved. Reconnect to refresh your groups.', 'warning'); }
    }, false, 'profile-name');
  }
  async function saveUPI(value: string) {
    await perform(async () => {
      const active = session;
      if (!active || activeSessionRef.current?.token !== active.token) throw new Error('Sign in again.');
      ++profileRevision.current;
      const result = await request<{ vpa: string }>(active, '/me/payment-profile', 'PUT', { vpa: value.trim() });
      if (activeSessionRef.current?.token !== active.token || ownerRef.current !== accountOwner(active) || result.vpa !== value.trim()) throw new Error('Could not confirm your UPI ID.');
      ++profileRevision.current; setVpa(result.vpa);
    }, false, 'profile-upi');
  }
  const accountRefresh = useRef<{ scope: string; token: string; generation: number; groups?: string[]; promise: Promise<void> } | null>(null);
  function syncAccount(active: Session, groupIds?: string[]): Promise<void> {
    const scope = accountOwner(active), existing = accountRefresh.current, generation = scopeGeneration.current;
    if (existing?.scope === scope && existing.token === active.token && existing.generation === generation) {
      if (!existing.groups || groupIds && groupIds.every(id => existing.groups!.includes(id))) return existing.promise;
      return existing.promise.then(() => syncAccount(active, groupIds));
    }
    const promise = runAccountRefresh(active, groupIds).finally(() => { if (accountRefresh.current?.promise === promise) accountRefresh.current = null; });
    accountRefresh.current = { scope, token: active.token, generation, groups: groupIds, promise };
    return promise;
  }
  async function runAccountRefresh(active: Session, groupIds?: string[]) {
    const syncingScope = accountOwner(active), generation = scopeGeneration.current;
    const current = () => scopeGeneration.current === generation && ownerRef.current === syncingScope && activeSessionRef.current?.token === active.token && !authHeldRef.current;
    if (!current()) return;
    setSyncing(true); setSyncProblem(false);
    try {
    if (!groupIds) setVerifiedEmptyOwner('');
    const db = await getDatabase(), scope = accountOwner(active);
    if (!current()) return;
    if (!groupIds) await readProfile(active);
    if (!current()) return;
    try { if (!groupIds) { const entry = await request<{ needs_invitation: boolean }>(active, '/me/bill-email-entry'); if (current()) setNeedsInvitation(entry.needs_invitation); } } catch { /* The ledger remains usable if this optional entry hint is unavailable. */ }
    let writeError: unknown;
    try { if (!groupIds) await syncOutbox(db, active, 'summary', undefined, current); } catch (error) { if (error instanceof ApiError && error.status === 401) throw error; writeError = error; }
    if (!current()) return;
    if (!groupIds && !writeError && await retryAccountMediaUploads(db, active, undefined, current)) setSyncProblem(true);
    if (!current()) return;
    const removed = await refreshGroups(db, active, 'summary', undefined, { groupIds, current });
    await load(scope);
    if (!current()) return;
    if (activeGroupRef.current && removed.includes(activeGroupRef.current)) { navigate('home'); setNotice('You no longer have access to that group.', 'warning'); }
    if (writeError) throw writeError;
    if (current() && !groupIds) { setVerifiedEmptyOwner(scope); void downloadOffline(active); }
    } catch (error) { if (current()) { if (error instanceof ApiError && error.status === 401) setExpired(true); setSyncProblem(true); await publishIfChanged().catch(() => {}); } throw error; }
    finally { if (current()) setSyncing(false); }
  }
  async function downloadOffline(active: Session) {
    if (offlineDownload.current) return;
    const scope = accountOwner(active), current = () => ownerRef.current === scope && activeSessionRef.current?.token === active.token && !authHeldRef.current;
    const job = (async () => {
      await Promise.resolve();
      if (!current()) return;
      setDownloadingOwner(scope);
      try {
        const db = await getDatabase();
        await cacheOfflineGroups(db, active, current);
        const confirmed = await confirmSync(db, scope, current);
        if (!current()) return;
        setSyncProblem(!confirmed); await load(scope);
      } catch { if (current()) setSyncProblem(true); }
      finally { if (ownerRef.current === scope) setDownloadingOwner(''); }
    })();
    offlineDownload.current = job;
    try { await job; } finally { if (offlineDownload.current === job) offlineDownload.current = null; }
  }
  async function sync() {
    if (!session) throw new Error('Sign in to continue.');
    await syncAccount(session);
  }
  async function loadBalanceGroup(expected: Group) {
    const active = activeSessionRef.current;
    if (!active || accountOwner(active) !== owner) throw new Error('This account changed. Reopen the group.');
    return loadBalanceSource(await getDatabase(), active, expected, () => ownerRef.current === owner && activeSessionRef.current?.token === active.token);
  }
  async function withBill(active: Session, group: Group, id?: string): Promise<Group> {
    if (!id) return group;
    const cached = group.expenses.find(value => value.id === id) ?? (group.focused_expense?.id === id ? group.focused_expense : undefined);
    if (cached) return group;
    let detail: Expense & { group_version: number; group_id: string };
    try { detail = await request(active, `/groups/${group.id}/expenses/${encodeURIComponent(id)}?version=${group.version}`); }
    catch (error) { if (cached && !(error instanceof ApiError)) return group; throw error; }
    if (detail.group_version !== group.version || detail.group_id !== group.id) throw new Error('This bill changed. Refresh the group and try again.');
    return { ...group, expenses: group.expenses.map(value => value.id === id ? detail : value), focused_expense: detail };
  }
  async function saveReadGroup(active: Session, group: Group, current = () => true, mergeDetail = true): Promise<boolean> {
    const db = await getDatabase(), scope = accountOwner(active), stale = new Error('This account or screen changed.');
    const allowed = () => current() && activeSessionRef.current?.token === active.token;
    let saved = false;
    try {
      await db.withExclusiveTransactionAsync(async tx => {
        if (!allowed()) return;
        const cached = await readVisibleGroup(tx, scope, group.id);
        if (!allowed() || cached?.kind === 'unavailable') return;
        // Read authorization and merge focused detail under the same writer transaction.
        if (cached && cached.group.version > group.version) return;
        if (mergeDetail && cached?.group.version === group.version && (group.focused_expense || group.focused_settlement)) {
          group = { ...cached.group, ...(group.focused_expense && { focused_expense: group.focused_expense }), ...(group.focused_settlement && { focused_settlement: group.focused_settlement }) };
        }
        await saveGroup(tx, scope, group, 'shared');
        if (!allowed()) throw stale; // Roll back if the route/session left during storage work.
        saved = true;
      });
    } catch (error) { if (error !== stale) throw error; }
    return saved && allowed();
  }

  async function openBill(bill: BillRow) {
    await browse(`bill:${selected?.group.id}:${bill.id}`, async current => {
      if (!session || !selected) return;
      if (pending.some(value => value.body.id === bill.id && /\/expenses(?:\/[^/]+)?$/.test(value.path))) { navigate('expenseDetail', { expenseId: bill.id }); return; }
      const active = session, group = await withBill(active, selected.group, bill.id);
      if (!current()) return;
      if (group !== selected.group && !await saveReadGroup(active, group, current)) return;
      if (current()) navigate('expenseDetail', { expenseId: bill.id });
    });
  }
  async function withPayment(active: Session, group: Group, id: string): Promise<Group> {
    const cached = group.settlements.find(value => value.id === id) ?? (group.focused_settlement?.id === id ? group.focused_settlement : undefined);
    if (cached) return group;
    let payment: Settlement & { group_version: number };
    try { payment = await request(active, `/groups/${group.id}/settlements/${encodeURIComponent(id)}?version=${group.version}`); }
    catch (error) { if (cached && !(error instanceof ApiError)) return group; throw error; }
    if (payment.id !== id || payment.group_version !== group.version) throw new Error('This payment changed. Refresh and try again.');
    return { ...group, settlements: group.settlements.map(value => value.id === id ? payment : value), focused_settlement: payment };
  }
  async function openPayment(id: string) {
    await browse(`payment:${selected?.group.id}:${id}`, async current => {
      if (!session || !selected) return;
      if (pending.some(value => value.body.id === id && value.path.endsWith('/settlements'))) { navigate('paymentDetail', { settlementId: id }); return; }
      const active = session, group = await withPayment(active, selected.group, id);
      if (!current()) return;
      if (group !== selected.group && !await saveReadGroup(active, group, current)) return;
      if (current()) navigate('paymentDetail', { settlementId: id });
    });
  }
  useEffect(() => {
    const enabled = !!session && ready && foreground && online && !expired && !authHeld && !busy && !syncing;
    readPrefetch.configure(session && !authHeld ? readScope(session) : '', enabled);
    if (!enabled || !session) return;
    const active = session, scope = accountOwner(active);
    const timer = setTimeout(() => {
      void prefetchRead<ActivityPage>(active, '/activity?limit=50').then(page => {
        if (!page || page.read_mode !== 'activity' || !Array.isArray(page.items) || activeSessionRef.current?.token !== active.token || ownerRef.current !== scope) return;
        setActivity(previous => previous ?? { ...page, firstPage: true });
        if (activityOwner.current !== scope) activityOwner.current = scope;
      });
      for (const path of ['/me', '/me/notifications/preferences', '/me/chat-conversations?limit=20']) void prefetchRead(active, path);
    }, 600);
    return () => clearTimeout(timer);
  }, [session?.token, session?.baseUrl, ready, foreground, online, expired, authHeld, busy, syncing]);
  useEffect(() => () => readPrefetch.configure('', false), []);

  // Warm only three visible, uncached bill details after scrolling settles.
  useEffect(() => {
    if (!session || screen !== 'group' || !selected || busy || !foreground || !online || authHeld || expired || pending.length || visibleBills.scope !== `${owner}|${groupId}`) return;
    const active = session, group = selected.group;
    const timer = setTimeout(() => {
      for (const id of visibleBills.ids.slice(0, 3)) {
        if (!group.expenses.some(bill => bill.id === id)) void prefetchRead(active, `/groups/${group.id}/expenses/${encodeURIComponent(id)}?version=${group.version}`);
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [session?.token, screen, groupId, selected?.group.version, visibleBills, foreground, online, authHeld, expired, busy, pending.length]);

  async function refreshActivity(more = false, signal?: AbortSignal, force = false): Promise<boolean> {
    const active = session, context = browseCurrent.current, previous = activity;
    if (!active) return false;
    if (force) readPrefetch.invalidate(readScope(active));
    const read = async (current = () => true) => {
      if (!more) setActivityError('');
      try {
        const cursor = more ? previous?.next_cursor : null;
        if (more && !cursor) return false;
        const page = await request<ActivityPage>(active, `/activity?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, 'GET', undefined, 'json', signal);
        if (!current() || signal?.aborted || activeSessionRef.current?.token !== active.token || browseCurrent.current !== context) return false;
        if (page.read_mode !== 'activity' || !Array.isArray(page.items) || more && page.revision !== previous?.revision) throw new ApiError(409, 'Activity changed. Refresh to see the latest.');
        const added = more ? page.items.filter(item => !previous?.items.some(old => old.id === item.id)) : page.items;
        activityOwner.current = accountOwner(active);
        setActivity({ ...page, items: more ? [...(previous?.items ?? []), ...added] : added, firstPage: more ? previous?.firstPage ?? false : true });
        return added.length > 0;
      } catch (error) {
        if (!current() || signal?.aborted || activeSessionRef.current?.token !== active.token || browseCurrent.current !== context) return false;
        if (error instanceof ApiError && [401, 403, 404, 409].includes(error.status)) { setActivity(null); activityOwner.current = ''; }
        if (!more || error instanceof ApiError && [401, 403, 404, 409].includes(error.status)) setActivityError(error instanceof ApiError && error.status === 409 ? 'Activity changed. Refresh to see the latest.' : 'Could not load activity. Try again.');
        if (error instanceof ApiError && error.status === 401) setExpired(true);
        throw error;
      }
    };
    return more || activity?.items.length || readPrefetch.peek(readScope(active), '/activity?limit=50') ? read() : browse('activity', read, false);
  }
  useEffect(() => {
    if (ready && session && !authHeld && !expired && foreground && screen === 'home' && tab === 'Activity' && !busy && activityOwner.current !== owner && !activityError) void refreshActivity().catch(() => {});
  }, [ready, session?.token, authHeld, expired, foreground, screen, tab, busy, owner, activityError]);
  function chatInboxEmptyChanged(active: Session, empty: boolean) {
    const account = accountOwner(active), scope = `${account}|${active.token}`;
    if (ownerRef.current !== account) return;
    if (!empty) setEmptyChatScope(previous => previous === scope ? '' : previous);
    else if (activeSessionRef.current?.token === active.token) setEmptyChatScope(scope);
  }
  async function openActivityTarget(target: ActivityTarget, chat = false) {
    await browse(`activity:${target.groupId}:${target.kind}:${target.kind === 'bill' ? target.expenseId : target.kind === 'payment' ? target.settlementId : ''}:${chat}`, async current => {
      if (!session) return;
      const active = session;
      let group = await fetchGroup(active, target.groupId);
      if (target.kind === 'bill') group = await withBill(active, group, target.expenseId);
      if (target.kind === 'payment') group = await withPayment(active, group, target.settlementId);
      if (!current()) return;
      if (!await saveReadGroup(active, group, current)) return;
      if (current()) navigate(target.kind === 'bill' ? chat ? 'billChat' : 'expenseDetail' : target.kind === 'payment' ? 'paymentDetail' : 'group', { groupId: group.id, expenseId: target.kind === 'bill' ? target.expenseId : null, settlementId: target.kind === 'payment' ? target.settlementId : null });
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
      setTransfer(undefined); navigation.complete('group', { groupId: group.id });
      setActivity(null); activityOwner.current = '';
      setNotice(paid ? `Recorded ${formatMoney(record.amount)} paid to ${record.payeeName}.` : 'Unpaid attempt cancelled.', paid ? 'success' : 'info');
    }, false);
  }
  async function historyPage(resource: HistoryResource, direction: 'next' | 'previous' | 'search', query?: string, target?: Group, signal?: AbortSignal): Promise<boolean> {
    const active = session, group = target ?? selected?.group, context = browseCurrent.current;
    if (!group?.history || !active) return false;
    async function unavailable() {
      setGroups(rows => rows.filter(row => row.group.id !== group!.id)); navigate('home');
      const db = await getDatabase();
      for (const table of ['groups_cache', 'group_summaries']) await db.runAsync(`UPDATE ${table} SET kind='unavailable' WHERE owner=? AND id=?`, accountOwner(active!), group!.id);
      await db.runAsync('DELETE FROM expense_history WHERE owner=? AND group_id=?', accountOwner(active!), group!.id);
      await db.runAsync('DELETE FROM sync_state WHERE owner=?', accountOwner(active!));
      await refreshGroups(db, active!, 'summary').then(() => load(accountOwner(active!))).catch(() => {});
    }
    const read = async (current = () => true) => {
      const window = group.history![resource]; if (!window) return false;
      const previous = window.previous ?? [];
      const cursor = direction === 'next' ? window.next_cursor : direction === 'previous' ? previous.at(-1) ?? null : null;
      if (direction === 'next' && !cursor) return false;
      const search = ['bills', 'transactions'].includes(resource) ? query ?? window.query ?? '' : '';
      const params = new URLSearchParams({ version: String(group.version), limit: '50' });
      if (cursor) params.set('cursor', cursor);
      if (resource === 'bills' || resource === 'transactions') { params.set('deleted', 'all'); if (search) params.set('q', search); }
      try {
        const page = await request<{ read_mode: string; group_id: string; version: number; items: any[]; next_cursor: string | null }>(active, `/groups/${group.id}/history/${resource}?${params}`, 'GET', undefined, 'json', signal);
        if (!current() || signal?.aborted || activeSessionRef.current?.token !== active.token || browseCurrent.current !== context) return false;
        if (page.read_mode !== 'page' || page.group_id !== group.id || page.version !== group.version || !Array.isArray(page.items)) throw new ApiError(409, 'History changed. Refresh before continuing.');
        const field = { bills: 'expenses', activity: 'activity', settlements: 'settlements', attempts: 'payment_attempts', transactions: 'transactions' }[resource];
        const rows = resource === 'transactions' ? group.transactions ?? [] : resource === 'bills' ? group.expenses : resource === 'settlements' ? group.settlements : resource === 'attempts' ? group.payment_attempts ?? [] : group.activity;
        const identity = (row: any) => resource === 'transactions' ? `${row.kind}:${row.bill?.id ?? row.payment?.id}` : row.id ?? row.sequence;
        const added = page.items.filter(row => !rows.some(old => identity(old) === identity(row)));
        if (!await saveReadGroup(active, { ...group, [field]: direction === 'next' ? [...rows, ...added] : page.items, history: { ...group.history, [resource]: { next_cursor: page.next_cursor, cursor: direction === 'next' ? window.cursor ?? null : cursor, previous: [], query: search } } }, () => current() && !signal?.aborted && browseCurrent.current === context, false)) return false;
        if (!current() || signal?.aborted || activeSessionRef.current?.token !== active.token || browseCurrent.current !== context) return false;
        await load(accountOwner(active));
        if (!signal?.aborted && activeSessionRef.current?.token === active.token && activeGroupRef.current === group.id) setLedgerRevision(value => value + 1);
        return direction !== 'next' || (resource === 'settlements' ? added.some(row => row.sender === selfId || row.recipient === selfId) : added.length > 0);
      } catch (error) {
        if (!current() || signal?.aborted || activeSessionRef.current?.token !== active.token || browseCurrent.current !== context) return false;
        if (error instanceof ApiError && error.status === 401) setExpired(true);
        if (error instanceof ApiError && [403, 404].includes(error.status)) {
          await unavailable();
        } else if (error instanceof ApiError && error.status === 409) {
          try {
            const updated = await fetchGroup(active, group.id);
            if (current() && !signal?.aborted && activeSessionRef.current?.token === active.token && browseCurrent.current === context) {
              if (await saveReadGroup(active, updated, () => current() && !signal?.aborted && browseCurrent.current === context, false)) await load(accountOwner(active));
            }
          } catch (cause) {
            if (current() && !signal?.aborted && activeSessionRef.current?.token === active.token && browseCurrent.current === context && cause instanceof ApiError) {
              if ([403, 404].includes(cause.status)) await unavailable();
              if (cause.status === 401) setExpired(true);
            }
          }
        }
        throw error;
      }
    };
    return direction === 'next' ? read() : browse(`history:${group.id}:${resource}:${direction}:${query ?? ''}`, read);
  }
  useEffect(() => { if (ready && session && foreground && !expired && !authHeld) notices.engage(); }, [ready, session?.token, foreground, expired, authHeld]);
  useEffect(() => {
    const update = () => { const active = AppState.currentState === 'active' && (Platform.OS !== 'web' || document.visibilityState === 'visible'); if (active) activityOwner.current = ''; setForeground(active); if (active) requestAnimationFrame(measureViewport); };
    const listener = AppState.addEventListener('change', update);
    if (Platform.OS === 'web') { document.addEventListener('visibilitychange', update); window.addEventListener('resize', measureViewport); window.addEventListener('pointerdown', engage, true); window.addEventListener('keydown', engage, true); }
    return () => { listener.remove(); if (Platform.OS === 'web') { document.removeEventListener('visibilitychange', update); window.removeEventListener('resize', measureViewport); window.removeEventListener('pointerdown', engage, true); window.removeEventListener('keydown', engage, true); } };
  }, []);
  useEffect(() => {
    if (Platform.OS !== 'web' || storageIsDurable() || !commands.length && !hasDrafts && !pendingFiles) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [commands.length, hasDrafts, pendingFiles]);
  useEffect(() => {
    const update = () => setOnline(isOnline());
    if (Platform.OS !== 'web') return subscribeConnection(update);
    const unsubscribe = subscribeConnection(update);
    window.addEventListener('online', update); window.addEventListener('offline', update);
    return () => { unsubscribe(); window.removeEventListener('online', update); window.removeEventListener('offline', update); };
  }, []);
  function openMe() { navigate('home', { tab: 'Account' }); }
  useEffect(() => {
    if (!challenge && !emailRequested) return;
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [challenge, emailRequested]);
  useEffect(() => {
    if (!ready || !session || authHeld || authHeldRef.current || activeSessionRef.current?.token !== session.token || expired || busy || !appLink) return;
    if ('groupInviteToken' in appLink) return;
    const active = session, target = appLink;
    open(() => browse(`link:${JSON.stringify(target)}`, async current => {
      await draftWrites.current;
      if (!current()) return;
      try {
        const id = 'inviteToken' in target
          ? (await perform(() => request<{ id: string }>(active, `/invites/${encodeURIComponent(String(target.inviteToken))}/claim`, 'POST', { command_id: uuid() }))).id
          : target.groupId;
        let group: Group;
        try { group = await fetchGroup(active, id); }
        catch (error) {
          const cached = await readVisibleGroup(await getDatabase(), accountOwner(active), id);
          if (error instanceof ApiError && error.status < 500 || !cached || cached.kind === 'unavailable') throw error;
          group = cached.group;
        }
        group = await withBill(active, group, target.expenseId);
        if (!current() || !await saveReadGroup(active, group, current) || !current()) return;
        const bill = target.expenseId && (group.expenses.find(value => value.id === target.expenseId) ?? (group.focused_expense?.id === target.expenseId ? group.focused_expense : undefined));
        navigate(bill ? target.chat ? 'billChat' : target.versions ? 'expenseVersions' : 'expenseDetail' : 'group', { groupId: group.id, expenseId: bill ? bill.id : null, tab: group.is_direct ? 'Friends' : 'Groups' });
      } catch (error) {
        if (!current()) return;
        if (error instanceof ApiError && error.status === 404) { navigate('home'); setNotice('This link is unavailable, or your request is waiting for approval.', 'warning'); }
        else throw error;
      } finally {
        // Only read-only group links can retry after session validation.
        const interrupted = 'groupId' in target && (authHeldRef.current || activeSessionRef.current?.token !== active.token);
        if (!interrupted) setAppLink(current => current === target ? null : current);
      }
    }));
  }, [ready, session?.token, authHeld, expired, busy, appLink]);
  // Browser history is owned by the navigator. Resolve uncached entries through
  // the same authenticated link loader used by native links and notifications.
  useEffect(() => {
    if (!ready || !session || authHeld || expired || busy || appLink || !groupId) return;
    const scope = `${session.token}|${navigation.route.key}`;
    if (resolvedRoute.current === scope) return;
    if (!selected || expenseId && !expense || settlementId && !settlement) {
      resolvedRoute.current = scope;
      if (screen === 'group' || ['expenseDetail', 'expenseVersions', 'billChat'].includes(screen)) setAppLink({ groupId, ...(expenseId ? { expenseId, ...(screen === 'billChat' ? { chat: true as const } : screen === 'expenseVersions' ? { versions: true as const } : {}) } : {}) });
    }
  }, [ready, session?.token, authHeld, expired, busy, navigation.route.key, screen, groupId, expenseId, !!selected, !!expense, appLink]);
  useEffect(() => {
    if (authHeld || screen !== 'home' || tab !== 'Account' || !session || expired) return;
    const active = session;
    void background(() => readProfile(active), false).catch(() => {});
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
  useEffect(() => { if (ready && owner) void load().catch(error => setNotice(error.message, 'error')); }, [owner, ready, online]);
  useEffect(() => {
    if (!ready || !session || authHeld || expired) return;
    const reconnect = () => { if (authHeldRef.current) return; if (Platform.OS === 'web') queueCookieCheck(); else if (!lock.current) syncQuietly(); else deferredSync.current = true; };
    if (Platform.OS === 'web' && validatedBrowserSession.current === session.token) { if (!lock.current) syncQuietly(); else deferredSync.current = true; } else reconnect();
    const listener = AppState.addEventListener('change', state => { if (state === 'active') reconnect(); });
    if (Platform.OS === 'web') window.addEventListener('online', reconnect);
    return () => { listener.remove(); if (Platform.OS === 'web') window.removeEventListener('online', reconnect); };
  }, [owner, ready, expired, session?.token, authHeld]);
  useEffect(() => {
    if (!ready || !session || !foreground || authHeld || expired) return;
    let stopped = false, checking = false;
    const active = session;
    const timer = setInterval(async () => {
      if (stopped || checking || lock.current || authHeldRef.current || activeSessionRef.current?.token !== active.token) return;
      checking = true;
      try {
        const queue = await pendingCommands(await getDatabase(), accountOwner(active));
        // Retry unsent changes only. Reading a ledger never starts a refresh timer.
        if (queue[0]?.state !== 'pending') return;
        const me = await request<{ id: number | string }>(active, '/me');
        if (stopped || activeSessionRef.current?.token !== active.token || authHeldRef.current) return;
        if (String(me.id) !== active.userId) { if (Platform.OS === 'web') queueCookieCheck(); return; }
        if (!lock.current) { if (Platform.OS === 'web') queueCookieCheck(); else syncQuietly(); }
        else deferredSync.current = true;
      } catch (error) { if (!stopped && error instanceof ApiError && error.status === 401) setExpired(true); }
      finally { checking = false; }
    }, 15_000);
    return () => { stopped = true; clearInterval(timer); };
  }, [ready, session?.token, foreground, authHeld, expired, lastConfirmed, syncProblem]);
  useEffect(() => {
    if (ready && session && !authHeld && !expired && !busy && deferredSync.current) { deferredSync.current = false; syncQuietly(); }
  }, [ready, session?.token, authHeld, expired, busy]);
  useEffect(() => {
    if (!ready || busy || authHeld || !pushTarget) return;
    setPushTarget(null);
    if (!session || pushTarget.token !== session.token) return;
    const active = session;
    open(() => browse(`push:${JSON.stringify(pushTarget.target)}`, async current => {
      await draftWrites.current;
      if (!current()) return;
      let target = pushTarget.target;
      if (target) {
        try {
          let group = await fetchGroup(active, target.group.id);
          group = await withBill(active, group, target.expenseId ?? undefined);
          target = { group, ...(target.chat ? { chat: true } : {}), expenseId: group.expenses.some(value => value.id === target?.expenseId && (target?.chat || !value.deleted)) || group.focused_expense?.id === target.expenseId ? target.expenseId : null };
        } catch { target = null; }
      }
      if (!current()) return;
      if (target && !await saveReadGroup(active, target.group, current)) return;
      if (!current()) return;
      if (target) {
        setGroups([{ kind: 'shared', group: target.group }]);
        navigate(target.expenseId ? target.chat ? 'billChat' : 'expenseDetail' : 'group', { groupId: target.group.id, expenseId: target.expenseId, tab: 'Groups' });
      } else setNotice('This bill is no longer available. Your groups are still here.');
    }));
  }, [ready, busy, authHeld, pushTarget, session?.token]);
  async function endPushSession(active: Session) {
    await push.disable().catch(() => {});
    await endSession(active);
    await push.clear(); setPushTarget(null);
  }
  function back() {
    if (screen === 'home' && tab === 'Groups' && (showArchived || showHidden)) { setShowArchived(false); setShowHidden(false); return; }
    navigation.back(!!session);
    if (screen === 'signInMethods') requestAnimationFrame(() => methodsRow.current?.focus());
  }
  useEffect(() => {
    const event = BackHandler.addEventListener('hardwareBackPress', () => {
      if (authHeldRef.current) return true;
      if (screen === 'home' && tab === 'Groups' && (showArchived || showHidden)) { back(); return true; }
      return false;
    });
    return () => event.remove();
  }, [screen, tab, showArchived, showHidden]);
  function command(method: Command['method'], path: string, body: Record<string, unknown>): Command {
    const id = typeof body.command_id === 'string' ? body.command_id : uuid(); return { command_id: id, group_id: groupId!, base_version: selected?.group.version ?? 0, method, path, body: { ...body, command_id: id }, state: 'pending', error: null };
  }
  function requireConnectionForTemporaryStorage() {
    if (!storageIsDurable() && !isOnline()) throw new Error('This temporary browser tab needs an internet connection to save changes. Keep the tab open and reconnect.');
  }
  async function queue(value: Command, replacing?: string, attachment?: PendingMediaUpload, onQueued?: () => void) {
    requireConnectionForTemporaryStorage();
    if (attachment) {
      if (!session) throw new Error('Sign in to save the file.');
      await enqueueExpenseWithMedia(await getDatabase(), session, value, attachment, replacing);
    } else if (replacing) await replaceCommand(await getDatabase(), owner, replacing, value);
    else if (/\/expenses(?:\/[^/]+)?$/.test(value.path)) await enqueueBill(await getDatabase(), owner, value);
    else await enqueue(await getDatabase(), owner, value);
    onQueued?.();
    await load(owner);
    if (session && isOnline()) {
      setSyncing(true);
      try { await syncOutbox(await getDatabase(), session, 'summary'); return; }
      catch (error) { if (error instanceof ApiError && error.status === 401) setExpired(true); setSyncProblem(true); return; }
      finally { if (ownerRef.current === owner) setSyncing(false); }
    }
  }
  async function openGroup(row: CachedGroup) { await browse(`group:${row.group.id}`, async current => { await draftWrites.current; const full = !isOnline() ? await readGroup(await getDatabase(), owner, row.group.id) : null; if (!current()) return; if (full?.kind === 'shared' && full.group.version === row.group.version) setGroups(rows => rows.map(value => value.group.id === row.group.id ? full : value)); navigate('group', { groupId: row.group.id, expenseId: null }); }); }
  async function openExpense(value?: Expense) {
    await browse(`edit:${groupId}:${value?.id ?? 'new'}`, async current => {
      await draftWrites.current;
      if (!current()) return;
      setReviewCommand(null); setReviewInput(undefined);
      navigate('expense', { expenseId: value?.id ?? null });
    });
  }
  async function saveExpense(value: Expense, attachment?: PendingMediaUpload, onQueued?: () => void) {
    const active = session, shouldPrompt = !!active && !expenseId && !vpa.trim() && !value.deleted && !!selfId && BigInt(value.paid[selfId] ?? '0') > BigInt(value.shares[selfId] ?? '0');
    await perform(async () => {
      if (!selected) throw new Error('Open a group first.');
      if (selected.group.archived) throw new Error('Reopen this group in settings before making changes.');
      await draftWrites.current;
      await queue(command(expenseId ? 'PUT' : 'POST', `/groups/${groupId}/expenses${expenseId ? `/${value.id}` : ''}`, expensePayload(value, !!expenseId)), reviewCommand?.command_id, attachment, onQueued);
      setReviewCommand(null); setReviewInput(undefined); navigation.complete('group');
      if (session && isOnline()) {
        const waiting = await retryAccountMediaUploads(await getDatabase(), session);
        try { await refreshGroups(await getDatabase(), session, 'summary'); } catch { /* A saved bill never needs to be created again after a file retry. */ }
        if (waiting) setSyncProblem(true);
      }
    });
    const key = `first-split:${owner}`;
    if (shouldPrompt && active && !upiPrompts.current.has(key)) {
      upiPrompts.current.add(key);
      const first = await claimFirstSplitUPIPrompt(owner).catch(() => false);
      if (first && ownerRef.current === owner && activeSessionRef.current?.token === active.token) {
        setUpiAfterSplit(true); setUpiSetup(true);
      }
    }
  }
  async function reverseExpense(value: Expense) {
    const route = navigation.ref.getRootState();
    if (!selected) return;
    if (selected.group.archived) throw new Error('Reopen this group in settings before making changes.');
    await queue(command('POST', `/groups/${groupId}/expenses/${value.id}/reverse`, { version: value.version }));
    if (navigation.ref.getRootState() === route) navigate('group');
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
      navigation.complete('group');
    });
  }
  async function reviewChange(value: Command) {
    await browse(`review:${value.command_id}`, async current => {
      if (!session) throw new Error('Sign in to continue.');
      const active = session, scope = owner;
      let group = await fetchGroup(active, value.group_id);
      try { group = await withBill(session, group, String(value.body.id ?? '')); }
      catch (error) { if (!(error instanceof ApiError && error.status === 404 && value.method === 'POST')) throw error; }
      if (!current() || ownerRef.current !== scope || activeSessionRef.current?.token !== active.token) return;
      if (!await saveReadGroup(active, group, current)) return; await load(scope);
      if (!current() || ownerRef.current !== scope || activeSessionRef.current?.token !== active.token) return;
      setReviewInput(undefined); setReviewCommand(value); navigate('review', { groupId: value.group_id, expenseId: null });
    });
  }
  async function reversePayment(value: Settlement) {
    if (!selected) return;
    if (selected.group.archived) throw new Error('Reopen this group in settings before making changes.');
    await queue(command('POST', `/groups/${groupId}/settlements/${value.id}/reverse`, {}));
  }
  async function changeMembership(action: 'leave' | 'restore') {
    const route = navigation.ref.getRootState();
    if (!session || !groupId) throw new Error('Open a group to continue.');
    const scope = owner, currentGroup = groupId;
    const result = await changeGroupMembership(await getDatabase(), session, currentGroup, action, { isOnline, flushDrafts: () => draftWrites.current, uuid });
    await load(scope);
    if (ownerRef.current !== scope || navigation.ref.getRootState() !== route) return;
    setShowArchived(false); setShowHidden(false); navigate('home');
    setNotice(result.disposition === 'left' ? 'You left the group. Its shared history remains.' : result.disposition === 'hidden' ? 'Removed from your list. You remain the organizer.' : 'Restored to your list.', 'success');
  }
  async function groupAction(suffix: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return perform(async () => {
      if (!session) throw new Error('Sign in to continue.');
      requireConnectionForTemporaryStorage();
      const retrying = pending.length === 1 && pending[0].state === 'pending' && body.command_id === pending[0].command_id;
      const localPerson = suffix === '/participants' || /^\/participants\/[^/]+\/name$/.test(suffix);
      if (!localPerson && !isOnline()) throw new Error('This action needs a connection. Your saved records stay on this device.');
      if (pending.length && !retrying && (!localPerson || pending.some(value => value.state !== 'pending'))) throw new Error('Review pending changes first.');
      const value = command('POST', `/groups/${groupId}${suffix}`, body), db = await getDatabase();
      await enqueue(db, owner, value); await load(owner);
      try {
        if (!isOnline() && localPerson) return { id: groupId, participant_id: body.id, pending: true };
        setSyncing(true);
        const receipts = await syncOutbox(db, session, 'summary'); return receipts.at(-1) ?? {};
      } catch (error) {
        if (localPerson && !(error instanceof ApiError) && (await pendingCommands(db, owner)).find(row => row.command_id === value.command_id)?.state === 'pending') return { id: groupId, participant_id: body.id, pending: true };
        throw error;
      } finally { if (ownerRef.current === owner) setSyncing(false); }
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
    if (await saveReadGroup(active, group, () => ownerRef.current === scope && activeGroupRef.current === id, false)) await load(scope);
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
        if (attempt) { group = { ...group, payment_attempts: [...(group.payment_attempts ?? []).filter(value => value.id !== attempt.id), attempt] }; if (!await saveReadGroup(session!, group, () => activeGroupRef.current === group.id, false)) throw new Error('This group changed. Reopen it before paying.'); }
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
      } else if (!await saveReadGroup(session, group, () => activeGroupRef.current === group.id, false)) throw new Error('This group changed. Reopen it before paying.');
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
    const value = await requestEmailCode(API_URL, email);
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
  async function finishGoogleSignIn(process: GoogleProcess, authenticate: GoogleAuthenticate, provider = 'Google') {
    const active = activeSessionRef.current;
    if (process === 'connect' && !active) throw new Error('Your signed-in account changed. Try again.');
    const epoch = process === 'login' ? ++authEpoch.current : authEpoch.current;
    const current = () => epoch === authEpoch.current && activeSessionRef.current?.token === active?.token;
    if (process === 'login' && Platform.OS === 'web') { authHeldRef.current = true; setCheckingCookie(true); await pauseAccountRequests(); }
    try {
      await draftWrites.current;
      if (!current()) return;
      const value = await authenticate(current);
      if (!value || !current()) return;
      if (process === 'connect') { providerConnections.refresh(); setNotice(`${provider} connected.`, 'success'); return; }
      await saveSession(value);
      if (!current()) return;
      if (active && active.token !== value.token) { if (Platform.OS !== 'web') await endPushSession(active); else await push.clear(); await clearMediaPreviews(); }
      if (!current()) return;
      validatedBrowserSession.current = value.token; changeScope(value); setChallenge(null); setCode('');
      if (Platform.OS === 'web') { resumeAccountRequests(); setCheckingCookie(false); authHeldRef.current = false; }
      await syncAccount(value);
    } finally {
      if (Platform.OS === 'web' && process === 'login' && epoch === authEpoch.current && !emailEntryRef.current) { authHeldRef.current = false; setCheckingCookie(false); resumeAccountRequests(); }
    }
  }
  const direct = tab === 'Friends';
  async function createGroup(values: NewGroupValues) {
    const route = navigation.ref.getRootState();
    if (!session) throw new Error('Sign in first.');
    requireConnectionForTemporaryStorage();
    const participants = [myName, ...values.people].map((name, index) => ({ id: uuid(), name: name.trim(), user_id: index === 0 ? Number(session.userId) : null, ...((index > 0 && (direct ? values.email : values.emails?.[index - 1] ?? '').trim()) ? { email: (direct ? values.email : values.emails?.[index - 1] ?? '').trim() } : {}) }));
    const group = { ...emptyGroup(uuid(), direct ? values.people[0].trim() : values.name, participants), owner_id: Number(session.userId), is_direct: direct };
    const id = uuid(), create: Command = { command_id: id, group_id: group.id, base_version: 0, method: 'POST', path: '/groups', body: { command_id: id, id: group.id, name: group.name, participants: participants.map(({ id, name, email }) => ({ id, name, ...(email ? { email } : {}) })), self_participant_id: participants[0].id, is_direct: direct }, state: 'pending', error: null };
    await createPendingGroup(await getDatabase(), owner, group, [create]); await load(owner);
    if (direct && values.email.trim()) {
      setNewPersonInvite({ owner, groupId: group.id, personId: participants[1].id, email: values.email.trim().toLowerCase(), id: uuid() }); setNewPersonInviteError('');
    }
    try { if (isOnline()) { setSyncing(true); await syncOutbox(await getDatabase(), session, 'summary'); } }
    catch (error) { if (error instanceof ApiError && error.status === 401) setExpired(true); setSyncProblem(true); }
    finally { if (ownerRef.current === owner) setSyncing(false); }
    if (navigation.ref.getRootState() === route) navigate('group', { groupId: group.id, expenseId: null });
  }
  async function sendNewPersonInvite() {
    const value = newPersonInvite;
    if (!value || busy || value.owner !== owner || groupId !== value.groupId || invitePerson?.email !== value.email) return;
    setNewPersonInviteError('');
    try {
      const result = await sendInvitation(value.groupId, { personId: value.personId, email: value.email, id: value.id }, groupAction);
      if (result.state !== 'sent' && result.state !== 'linked') throw new Error('Could not confirm this invitation. Try again shortly.');
      setNewPersonInvite(null);
    } catch (error) { setNewPersonInviteError(error instanceof Error ? error.message : 'Could not send this invitation. Try again.'); }
  }
  async function exportData() {
    await browse('export', async current => {
      if (!session || ownerRef.current !== owner) return;
      const active = session;
      await draftWrites.current; await flushChatWrites();
      const data = await portableExport(await getDatabase(), active, isOnline());
      if (!current() || ownerRef.current !== owner || activeSessionRef.current?.token !== active.token) return;
      if (data.account_data_status !== 'included') setNotice('Export includes saved work on this device. Server history was unavailable.', 'warning');
      await shareJson('merosplit-data', data);
    });
  }
  async function deleteAccount(body: { confirmation: 'delete'; email: string }) {
    if (!session) throw new Error('Sign in to continue.');
    const active = session, scope = owner;
    // Keep validation ahead of every destructive client or server side effect.
    const checked = accountDeletionInput(body.confirmation, body.email, active.email);
    await draftWrites.current; await flushChatWrites();
    const deleted = await request<{ deleted: boolean; apple_revocation?: string }>(active, '/account', 'DELETE', checked);
    await push.clear(); setPushTarget(null);
    const db = await getDatabase(); await clearAccountMediaUploads(db, active); await wipeAccount(db, scope);
    await clearMediaPreviews(); await saveSession(null); changeScope(null);
    if (deleted.apple_revocation && deleted.apple_revocation !== 'revoked') setNotice('Account deleted. Apple could not confirm disconnection. In your Apple Account, open Sign in with Apple and remove MeroSplit.', 'warning');
  }
  function beginEmailLink(link: EmailLink) {
    const previous = emailProof.current;
    if (emailEntryRef.current && previous?.id === link.id && (previous.proof === link.proof || emailEntryRef.current.phase !== 'opening' && !previous.proof)) return;
    authEpoch.current++; authHeldRef.current = true; activeSessionRef.current = null;
    emailProof.current = link; cookieCheck.current = false; setCheckingCookie(false); setAppLink(current => current && 'groupInviteToken' in current ? current : null); setPushTarget(null);
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
      if (!await saveReadGroup(active, group, () => epoch === authEpoch.current)) return; await load(accountOwner(active));
      if (epoch !== authEpoch.current || activeSessionRef.current?.token !== active.token) return;
      navigate('group', { groupId: group.id, expenseId: null, tab: group.is_direct ? 'Friends' : 'Groups' });
    } else navigate('home', { tab: 'Groups' });
    if (epoch === authEpoch.current) { forgetEmailProof(); emailProof.current = null; emailEntryRef.current = null; setEmailEntry(null); }
  }
  useEffect(() => {
    if (Platform.OS !== 'web') return startNativeLinks(Linking, value => {
      if (value.kind === 'email') beginEmailLink(value.link);
      else { if ('groupInviteToken' in value.target) void saveGroupInvite(value.target.groupInviteToken).catch(() => {}); setAppLink(value.target); }
    }, () => { void savedGroupInvite().then(token => { if (token && groupInviteToken('#token=' + encodeURIComponent(token))) setAppLink(current => current ?? { groupInviteToken: token }); }).catch(() => {}).finally(() => setNativeLinksReady(true)); });
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
    let checkedProof = proof;
    if (proof) {
      let inspection: EmailLinkInspection;
      try {
        inspection = Platform.OS === 'web' ? await inspectEmailLink(API_URL, entry.id, proof)
          : await inspectNativeEmailLink(API_URL, entry.id, proof, prior ?? undefined);
      } catch (error) {
        // A consumed link can only resume its already authenticated recipient.
        // Do not exchange the bearer after a failed preview.
        if (!(error instanceof EmailLinkError || error instanceof NativeEmailLinkError) || error.status !== 400 || entry.switchFromUserId !== undefined) throw error;
        checkedProof = null;
      }
      if (epoch !== authEpoch.current) return;
      if (checkedProof) {
        if (entry.switchFromUserId !== undefined && entry.switchFromUserId !== inspection!.currentUserId) throw new Error('Your account changed. Open this link again.');
        if (inspection!.currentUserId !== null && inspection!.currentUserId !== inspection!.userId && entry.switchFromUserId === undefined) {
          const next: EmailEntry = { ...entry, phase: 'switch', inspection: inspection! };
          emailEntryRef.current = next; setEmailEntry(next);
          return;
        }
      }
    }
    const result = Platform.OS === 'web'
      ? await resolveEmailLink(API_URL, { id: entry.id, proof: checkedProof }, () => epoch === authEpoch.current, entry.switchFromUserId)
      : await resolveNativeEmailLink(API_URL, { id: entry.id, proof: checkedProof }, () => epoch === authEpoch.current, prior ?? undefined, undefined, entry.switchFromUserId);
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
  function confirmAccountSwitch() {
    const entry = emailEntryRef.current;
    if (busy || entry?.phase !== 'switch' || !entry.inspection?.currentUserId) return;
    const next: EmailEntry = { ...entry, phase: 'opening', switchFromUserId: entry.inspection.currentUserId };
    emailEntryRef.current = next; setEmailEntry(next);
  }
  function cancelAccountSwitch() {
    if (busy) return;
    authEpoch.current++;
    forgetEmailProof(); initialEmailLink.current = null; emailProof.current = null; emailEntryRef.current = null; setEmailEntry(null);
    authHeldRef.current = false; activeSessionRef.current = session;
    resumeAccountRequests(); queueCookieCheck();
  }
  function leaveEmailLink() {
    if (session && !emailEntryRef.current?.target) { cancelAccountSwitch(); return; }
    if (Platform.OS !== 'web' && session && !emailEntryRef.current?.target) setExpired(true);
    forgetEmailProof(); initialEmailLink.current = null; emailProof.current = null; emailEntryRef.current = null; setEmailEntry(null);
    authHeldRef.current = false; resumeAccountRequests(); queueCookieCheck();
  }
  const emailContent = !checkingCookie && emailEntry?.phase === 'switch' && emailEntry.inspection ? <SwitchAccountDialog currentEmail={emailEntry.inspection.currentEmail!} targetEmail={emailEntry.inspection.email} invitation={emailEntry.inspection.purpose === 'invite'} busy={busy} onSwitch={confirmAccountSwitch} onCancel={cancelAccountSwitch} />
      : !checkingCookie && emailEntry?.phase === 'name' ? <NameOnlyForm key={emailEntry.id} busy={busy} onSave={finishEmailName} />
      : <EmailLinkStatus opening={checkingCookie || emailEntry?.phase === 'opening' || emailEntry?.phase === 'target'} busy={busy} error={emailEntry?.error ?? ''} sent={!!emailEntry?.sent} canRenew={!!emailEntry?.id} onRetry={retryEmailLink} onRenew={() => void renewCurrentEmailLink()} onSignIn={leaveEmailLink} />;
  function renderScreen(route: AppRoute, focused: boolean, billQueued: () => void, insideHomeTabs = false) {
    const busy = submissions.current.has(route.key!) || submissions.current.has(`${route.key}|attachments`);
    const screen = session ? route.name : 'login', { tab = 'Groups', groupId = null, expenseId = null, settlementId = null } = route.params ?? {};
    const selected = groups.find(row => row.group.id === groupId) ?? null;
    const pending = commands.filter(command => command.group_id === groupId);
    const selfId = selected?.group.participants.find(person => session && !person.removed && String(person.user_id) === session.userId)?.id ?? '';
    let preview = selected?.group ?? null, previewError = '';
    if (preview && pending.length) { try { preview = previewPending(preview, pending); } catch (error) { previewError = error instanceof Error ? error.message : 'Sync to review saved changes.'; } }
    const expense = preview?.expenses.find(value => value.id === expenseId) ?? (preview?.focused_expense?.id === expenseId ? preview.focused_expense : undefined);
    const settlement = preview?.settlements.find(value => value.id === settlementId) ?? (preview?.focused_settlement?.id === settlementId ? preview.focused_settlement : undefined);
    const noticeVisibility = { notices: notices.notices, enabled: focused && !authHeld && foreground && !expired && !alertOpen && !pending.length, viewport, scrollEpoch, onVisible: notices.acknowledgeVisible };
    const browseScope = `${owner}|${session?.token}|${screen}|${tab}|${groupId}|${foreground}|${expired}|${authHeld}|${online}|${groupVersions.current}|${selected?.group.version}|${selected?.group.history?.transactions?.query ?? selected?.group.history?.bills?.query ?? ''}`;
    if (!ready) return <SafeAreaView style={[s.screen, s.loading]}><ActivityIndicator color={colors.accent} /><Text style={ui.caption}>Opening your groups…</Text></SafeAreaView>;
    if (storageError) return <SafeAreaView role="main" style={[s.screen, pageContentStyle]}><Text accessibilityRole="header" aria-level={1} style={ui.section}>Could not open saved records</Text><Text accessibilityRole="alert" style={ui.error}>{storageError}</Text><Button title="Retry" disabled={busy} onPress={() => launch(restore)} /></SafeAreaView>;
  if (authHeld && !session) return <EmailLinkScreen title={emailEntry?.phase === 'name' ? 'Name' : 'Sign in'} busy={busy}>{emailContent}</EmailLinkScreen>;
  if (screen === 'home' && session && !insideHomeTabs) return <HomeTabs selected={tab} busy={authHeld} onSelect={value => { setShowArchived(false); setShowHidden(false); if (value === 'Activity') { if (!readPrefetch.fresh(readScope(session), '/activity?limit=50')) activityOwner.current = ''; setActivityError(''); } navigate('home', { tab: value }); }}
    render={value => renderScreen({ ...route, params: { ...route.params, tab: value } }, focused && value === tab, billQueued, true)} />;
  const mascotEligible = online && isOnline() && !busy && !expired && !notice && !commands.length && !hasDrafts && !legacy.length && !recoveries.length && !unavailable.length && !returns.length;
  const activityEmptyVerified = mascotEligible && !activityError && activity?.firstPage === true && activityOwner.current === owner && emptyChatScope === `${owner}|${session?.token}`;
  const direct = tab === 'Friends';
  const hiddenGroups = groups.filter(row => row.group.hidden);
  const listedGroups = groups.filter(row => !row.group.hidden || commands.some(value => value.group_id === row.group.id) || !!session && row.group.participants.some(person => !person.removed && String(person.user_id) === session.userId && BigInt(row.group.balances[person.id] ?? '0') !== 0n));
  const archivedGroups = groupListRows(listedGroups, true);
  const visibleGroups = !direct && showHidden ? hiddenGroups : direct ? listedGroups.filter(row => !!session && visiblePeopleSummary(row.group, session.userId, commands.some(command => command.group_id === row.group.id))) : groupListRows(listedGroups, showArchived);
  const showAddExpense = screen === 'group' && !!selected && !selected.group.archived;
  const title = screen === 'savedChanges' ? 'Saved changes' : screen === 'home' ? (tab === 'Friends' ? 'People' : tab === 'Account' ? 'Me' : tab === 'Groups' && showHidden ? 'Removed from my list' : tab === 'Groups' && showArchived ? 'Archived groups' : tab) : screen === 'signInMethods' ? 'Sign-in methods' : screen === 'login' ? 'Sign in' : screen === 'create' ? (direct ? 'Add a person' : 'New group') : screen === 'expense' ? (expenseId ? 'Edit bill' : 'Add expense') : screen === 'expenseVersions' ? 'Version history' : screen === 'billChat' ? 'Bill chat' : screen === 'expenseDetail' ? expense?.description ?? 'Bill' : screen === 'settle' ? 'Payment' : screen === 'members' ? 'Group settings' : screen === 'review' ? 'Review your bill' : screen === 'paymentDetail' ? 'Payment record' : screen === 'import' ? 'Import from Splitwise' : selected ? groupDisplayName(selected.group, session?.userId) : 'Group';
  const listNotice = <>{!!notice && <MotionReveal><Text accessibilityLiveRegion="polite" accessibilityRole={feedback.tone === 'error' ? 'alert' : undefined} style={[ui.notice, feedback.tone === 'success' ? ui.success : feedback.tone === 'warning' ? ui.warning : feedback.tone === 'error' ? ui.error : undefined]}>{notice}</Text></MotionReveal>}
      {expired && screen !== 'login' && <Button title="Sign in again" kind="primary" onPress={() => { setChallenge(null); setCode(''); navigate('login'); }} />}</>;
  const savedChangesView = <SavedChanges expanded={screen === 'savedChanges'} commands={commands} groups={groups} busy={busy} expired={expired} onOpen={row => open(() => openGroup(row))} onReview={value => open(() => reviewChange(value))} onDiscard={value => confirm('Discard saved change?', 'Export first if needed. This removes only your unsent change. A request already accepted by the server is kept there.', async () => { await discardCommand(await getDatabase(), owner, value.command_id); })} onRetry={syncQuietly} />;
  const homeContext = <>{screen === 'home' && needsInvitation && <Text style={ui.notice}>A new bill includes your email. Ask its organizer to send you an invitation to see the bill.</Text>}</>;
  const paymentReturns = <>{screen === 'home' && session && returns.filter(value => value.launch === 'opened' || value.decision !== null || value.launch === 'opening').slice(0, 1).map(value => <Button key={value.attemptId} title="Review payment" disabled={busy} onPress={() => open(() => browse(`return:${value.attemptId}`, async current => { const group = await fetchGroup(session, value.groupId); if (!current() || !await saveReadGroup(session, group, current) || !current()) return; setReturnAttemptId(value.attemptId); setTransfer({ sender: value.sender, recipient: value.recipient, amount: value.amount }); navigate('settle', { groupId: group.id }); }))} />)}</>;
  const groupView = screen === 'group' && selected && preview ? <GroupScreen categoryIcons={categoryIcons} header={listNotice} previewError={previewError} noticeVisibility={noticeVisibility} key={`${owner}|${groupId}`} group={preview} accepted={selected.group} revision={ledgerRevision} onUpdatesAvailable={setLedgerUpdates} pending={pending} busy={busy} selfId={selfId} onLoadBalanceGroup={loadBalanceGroup} pagingScope={browseScope} active={focused && foreground && !expired && !authHeld} online={online} onRefresh={pullToRefresh} refreshing={false} onPrefetchPayment={payment => { if (session && selected && !pending.length && !selected.group.settlements.some(value => value.id === payment.id)) void prefetchRead(session, `/groups/${selected.group.id}/settlements/${encodeURIComponent(payment.id)}?version=${selected.group.version}`); }} onPrefetchBill={bill => { if (session && selected && !pending.length && !selected.group.expenses.some(value => value.id === bill.id)) void prefetchRead(session, `/groups/${selected.group.id}/expenses/${encodeURIComponent(bill.id)}?version=${selected.group.version}`); }} onVisibleBills={ids => { if (ownerRef.current === owner && activeGroupRef.current === groupId) setVisibleBills({ scope: `${owner}|${groupId}`, ids }); }} onHistoryPage={(resource, direction, query, signal, target) => historyPage(resource, direction, query, target, signal)} onExpense={value => { void openBill(value).catch(() => {}); }} onPayment={value => { void openPayment(value.id).catch(() => {}); }} onSettle={value => { setReturnAttemptId(null); setTransfer(value ? personalTransfers(preview, selfId).find(row => row.sender === value.sender && row.recipient === value.recipient) : undefined); navigate('settle'); }} onReverse={value => confirm('Reverse payment record?', 'This removes the payment from the group’s balances.', () => reversePayment(value))} /> : null;
  const activityView = screen === 'home' && tab === 'Activity' && session ? <ActivityScreen categoryIcons={categoryIcons} onVisibleExpenses={refs => { if (ownerRef.current === owner && activeSessionRef.current?.token === session.token) setVisibleActivity({ scope: `${owner}|${session.token}`, refs }); }} header={<>{listNotice}{homeContext}</>} footer={<>{paymentReturns}{screen === 'home' && tab === 'Activity' && session && <ChatInbox key={owner} session={session} active={focused && foreground && !authHeld && !expired && online} busy={busy} onEmptyChange={empty => chatInboxEmptyChanged(session, empty)} onOpen={(groupId, expenseId) => { void openActivityTarget({ kind: 'bill', groupId, expenseId }, true).catch(() => {}); }} />}</>} emptyVerified={activityEmptyVerified} showEmpty={activityEmptyVerified} items={activity?.items ?? []} busy={busy} error={activityError} hasMore={!!activity?.next_cursor} cursor={activity?.next_cursor} pagingScope={browseScope} active={focused && foreground && !expired && !authHeld} online={online} onRefresh={() => { void refreshActivity(false, undefined, true).catch(() => {}); }} onLoadMore={signal => refreshActivity(true, signal)} onOpen={target => { void openActivityTarget(target).catch(() => {}); }} /> : null;
  const loginContent = <SignInLayout busy={busy} onBack={session ? back : undefined}>{listNotice}
        {appLink && 'groupInviteToken' in appLink && <><Text style={ui.body}>Sign in to join the group. You will confirm before joining.</Text><Button title="Cancel invitation" contentStyle={{ minHeight: 48 }} disabled={busy} onPress={() => { forgetGroupInvite(); void saveGroupInvite(null).catch(() => {}); setAppLink(null); navigate(session ? 'home' : 'login'); }} /></>}
        {emailRequested ? <EmailLinkSent busy={busy} resendSeconds={Math.max(0, Math.ceil((retryAt - clock) / 1000))} onResend={() => launch(sendSignInLink)} onCode={() => setEmailRequested(false)} onChangeEmail={() => { setEmailRequested(false); setChallenge(null); setCode(''); }} />
          : !challenge ? <EmailSignIn email={email} busy={busy} onEmail={setEmail} sendLabel={Platform.OS === 'web' ? 'Email me a sign-in link' : undefined} onSend={() => launch(Platform.OS === 'web' ? sendSignInLink : sendSignInCode)} secondary={Platform.OS === 'web' && <Button title="Use a code instead" kind="text" contentStyle={{ minHeight: 48 }} disabled={busy || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())} onPress={() => { if (!busy && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) launch(sendSignInCode); }} />}>
            <AppleSignInButton baseUrl={API_URL} process="login" busy={busy} onAuthenticate={authenticate => launch(() => finishGoogleSignIn('login', authenticate, 'Apple'))} />
            <GoogleSignInButton baseUrl={API_URL} process="login" busy={busy} onAuthenticate={authenticate => launch(() => finishGoogleSignIn('login', authenticate))} />
          </EmailSignIn>
          : <CodeSignIn email={email} code={code} busy={busy} resendSeconds={Math.max(0, Math.ceil((retryAt - clock) / 1000))} onCode={setCode} onConfirm={() => launch(finishSignIn)} onResend={() => launch(sendSignInCode)} onChangeEmail={() => { setChallenge(null); setCode(''); }} />}
        <Button title="Need help signing in?" kind="text" contentStyle={{ minHeight: 48 }} onPress={() => launch(() => Linking.openURL(`${APP_ORIGIN}/support`))} />
  </SignInLayout>;
    return <>
    {screen !== 'login' && <ScreenHeader title={title} brand={!session} busy={busyRoutes.length > 0 || reading > 0} onFeedback={session && !authHeld && !expired && screen === 'home' && ['Groups', 'Friends', 'Activity'].includes(tab) ? () => setFeedbackOpen(true) : undefined} onBack={screen === 'home' && tab === 'Groups' && (showArchived || showHidden) || screen !== 'home' ? back : undefined} status={session ? <SyncStatus key={owner} confirmedAt={lastConfirmed} commands={commands} pendingFiles={pendingFiles} drafts={hasDrafts} durable={storageIsDurable()} working={busyRoutes.length > 0 || reading > 0 || syncing || pulling} syncing={syncing} problem={syncProblem} online={online} reviewRequired={expired || authHeld || !!unavailable.length} updatesAvailable={screen === 'group' && ledgerUpdates} onShowUpdates={() => setLedgerRevision(value => value + 1)} onExport={() => open(exportData)} onRetry={syncQuietly} onPress={() => navigate('savedChanges')} /> : undefined}>

      {screen === 'group' && selected && <IconAction name="settings" label="Group settings" disabled={busy} onPress={() => navigate('members')} />}
      {screen === 'members' && selected && !selected.group.is_direct && !selected.group.archived && selected.group.participants.some(person => person.id === selfId && !person.removed && person.user_id === selected.group.owner_id) && <IconAction name="personAdd" label="Add person" disabled={busy} onPress={() => setAddPersonRequest(value => value + 1)} />}
    </ScreenHeader>}
    <SceneTransition changeKey={`${screen}|${tab}|${groupId ?? ''}|${expenseId ?? ''}|${settlementId ?? ''}|${screen === 'login' && challenge ? 'code' : 'entry'}`} active={focused}>
    {screen === 'login' ? loginContent : groupView ? groupView : activityView ? activityView : screen === 'billChat' && session && selected && expense ? <BillChatScreen key={`${owner}|${groupId}|${expense.id}`} session={session} groupId={selected.group.id} expenseId={expense.id} billTitle={expense.description} billAmount={formatMoney(expense.total)} onOpenBill={() => navigate('expenseDetail')} active={focused && foreground && !authHeld && !expired} online={online} onRead={() => void push.clearReadPrompts().catch(() => {})} onUnsentChange={unsent => { if (ownerRef.current !== owner) return; if (unsent) { setHasDrafts(true); return; } void flushChatWrites().then(() => getDatabase()).then(db => db.getFirstAsync<{ n: number }>('SELECT count(*) AS n FROM drafts WHERE owner=? AND body<>?', owner, 'null')).then(value => { if (ownerRef.current === owner) setHasDrafts(!!value?.n); }).catch(() => {}); }} /> : screen === 'expenseVersions' && session && selected && expense ? <ExpenseVersionHistory key={`${owner}|${session.token}|${expense.id}`} session={session} groupId={selected.group.id} expenseId={expense.id} groupVersion={selected.group.version} title={expense.description} onInvalidated={() => { if (ownerRef.current === owner && activeSessionRef.current?.token === session.token) { setLastConfirmed(null); setSyncProblem(true); } }} active={focused && foreground && !authHeld && !expired} online={online} /> : <ScrollView role="main" ref={focused ? scroll : undefined} onLayout={focused ? measureViewport : undefined} onScroll={() => setScrollEpoch(value => value + 1)} scrollEventThrottle={100} key={`${owner}|${screen}|${groupId ?? ''}`} contentContainerStyle={[pageContentStyle, showAddExpense && { paddingBottom: 104 }]} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag"
      contentInsetAdjustmentBehavior={screen === 'home' && usesNativeHomeTabs ? 'automatic' : undefined}
      refreshControl={session && !expired && (screen === 'home' || screen === 'group') ? <RefreshControl refreshing={false} tintColor={colors.accent} colors={[colors.accent]} onRefresh={pullToRefresh} /> : undefined}>
      {listNotice}
      {homeContext}
      {screen === 'signInMethods' && session && <SignInMethods key={owner} session={session} busy={lock.current || expired} connections={providerConnections} onGoogle={authenticate => launch(() => finishGoogleSignIn('connect', authenticate))} onApple={authenticate => launch(() => finishGoogleSignIn('connect', authenticate, 'Apple'))} />}


      {screen === 'home' && (tab === 'Groups' || tab === 'Friends') && <>
        <GroupList emptyLabel={!direct && showHidden ? 'No removed groups' : !direct && showArchived ? 'No archived groups' : !direct && archivedGroups.length ? 'No active groups' : undefined} emptyVerified={!showArchived && !showHidden && !archivedGroups.length && !hiddenGroups.length && mascotEligible && !!owner && verifiedEmptyOwner === owner} decorated={!showArchived && !showHidden && !archivedGroups.length && !hiddenGroups.length} groups={visibleGroups} commands={commands} userId={session?.userId} busy={busy} direct={direct} onOpen={row => open(() => openGroup(row))} />
        {(direct || !showArchived && !showHidden) && <Button title={direct ? 'Add person' : 'New group'} icon="add" kind={!visibleGroups.length ? 'primary' : 'secondary'} disabled={busy} onPress={() => navigate('create')} />}
        {!direct && !showArchived && !showHidden && archivedGroups.length > 0 && <Button title="Archived groups" kind="text" disabled={busy} onPress={() => { setShowArchived(true); scroll.current?.scrollTo({ y: 0, animated: false }); }} />}
        {!direct && !showArchived && !showHidden && hiddenGroups.length > 0 && <Button title="Removed from my list" kind="text" disabled={busy} onPress={() => { setShowHidden(true); scroll.current?.scrollTo({ y: 0, animated: false }); }} />}
        {!!(legacy.length || unavailable.length) && <Button title="Review saved work" kind="text" onPress={openMe} />}
      </>}
      {paymentReturns}
      {screen === 'create' && session && <CreateGroupForm direct={direct} busy={busy} onCreate={values => launch(() => createGroup(values))} />}
      {screen === 'expenseDetail' && selected && expense && <><ExpenseDetail categoryIcons={categoryIcons} onHistory={() => navigate('expenseVersions')} noticeVisibility={noticeVisibility} selfId={selfId} expense={expense} group={preview ?? selected.group} busy={busy} pending={pending.some(row => row.body.id === expense.id)} canEdit={!selected.group.archived && !pending.some(row => row.body.id === expense.id && (row.attempted || row.state !== 'pending'))} onEdit={() => open(() => openExpense(expense))} chat={session && (selected.group.expenses.some(value => value.id === expense.id) || selected.group.focused_expense?.id === expense.id) ? <BillChatEntry key={`${owner}|${expense.id}`} session={session} groupId={selected.group.id} expenseId={expense.id} active={focused && foreground && !expired && !authHeld} disabled={busy} onOpen={() => navigate('billChat')} /> : undefined} onReverse={() => confirm('Reverse bill record?', 'Creates a reversal record and updates balances. The original bill stays in history.', () => reverseExpense(expense))} attachments={
        !expense.deleted && (!(selected.group.expenses.some(value => value.id === expense.id) || selected.group.focused_expense?.id === expense.id) ? <Text style={ui.caption}>Pending sync</Text> : <BillAttachments key={`${owner}|${groupId}|${expense.id}`} session={session} groupId={selected.group.id} expenseId={expense.id} revision={selected.group.version} readOnly={selected.group.archived || !!pending.length} busy={busy}
          onBusyChange={value => setSubmission(value, `${route.key}|attachments`)} onChanged={async () => { if (!session) return; const scope = accountOwner(session); const updated = await fetchGroup(session, selected.group.id); if (await saveReadGroup(session, updated, () => ownerRef.current === scope, false)) await load(scope); }} />)} />
      </>}
      {screen === 'expense' && selected && <ExpenseForm key={`${owner}|${groupId}|${expenseId ?? 'new'}`} group={preview ?? selected.group} expense={reviewInput ?? expense} selfId={selfId} busy={busy} owner={owner} writes={draftWrites} onSave={(value, attachment, onQueued) => saveExpense(value, attachment, () => { onQueued?.(); billQueued(); })} />}
      {screen === 'review' && selected && reviewCommand && <SavedChangeScreen command={reviewCommand} group={selected.group} busy={busy} onDiscard={() => confirm('Discard this unsent change?', 'Accepted records remain. Your saved change will be removed from this phone.', async () => { await discardCommand(await getDatabase(), owner, reviewCommand.command_id); setReviewCommand(null); navigate('group'); })} onEditSaved={value => { setReviewInput(value); navigate('expense', { expenseId: reviewCommand.method === 'PUT' ? value.id : null }); }} />}
      {screen === 'settle' && selected && preview && <SettleForm key={`${owner}|${groupId}`} group={preview} initial={transfer} busy={busy} selfId={selfId} onReviewAttempt={reviewPaymentAttempt} onPrepareUPI={prepareUPI} onCancelUPI={async id => { await groupAction(`/payment-attempts/${id}/cancel`, {}); await clearPaymentReturn(await getDatabase(), owner, id); await load(); }} returnPayment={returnPayment} onArmReturn={armPaymentReturn} onReturnPaymentChange={persistPaymentReturn} onResolveReturn={finishPaymentReturn} onSave={savePayment} onCancel={() => { setReturnAttemptId(null); back(); }} />}
      {screen === 'paymentDetail' && selected && settlement && <PaymentDetail payment={settlement} group={preview ?? selected.group} selfId={selfId} busy={busy} canReverse={!pending.length && !selected.group.archived} onReverse={() => confirm('Reverse payment record?', 'This removes the payment from the group’s balances.', () => reversePayment(settlement))} />}
      {screen === 'members' && selected && <MembersScreen key={`${owner}|${groupId}`} group={preview ?? selected.group} selfId={selfId} busy={busy} onAction={groupAction} onMembership={action => { if (action === 'restore') launch(() => changeMembership(action)); else confirm('Delete group?', 'Leave this group and remove it from your list. Shared balances and history stay. Your saved drafts are kept.', () => changeMembership(action)); }} addPersonRequest={addPersonRequest} />}

      {screen === 'savedChanges' && (commands.length ? savedChangesView : <Text>Nothing is waiting to sync.</Text>)}
      {screen === 'import' && session && <SplitwiseImportScreen key={owner} session={session} busy={busy}
        onBusyChange={value => setSubmission(value, `${route.key}|import`)} onCancel={back}
        onImported={(group, alreadyImported) => { if (ownerRef.current !== accountOwner(session)) return; setGroups(rows => [...rows.filter(row => row.group.id !== group.id), { kind: 'shared', group }]); if (navigation.ref.getCurrentRoute()?.key !== route.key) return; navigate('group', { groupId: group.id, expenseId: null, tab: 'Groups' }); setNotice(alreadyImported ? 'Already imported.' : 'Imported.', 'success'); }} />}
      {screen === 'home' && tab === 'Account' && session && <>
        <AccountHeader key={owner} session={session} name={myName} busy={busy} onBusyChange={value => setSubmission(value, `${route.key}|profile-photo`)} />
        <View><ProfileSettings key={`profile-settings|${owner}`} name={myName} vpa={vpa} busy={busy} onSaveName={saveName} onSaveUPI={saveUPI} onAppearance={value => perform(() => changeAppearance(value), false, 'appearance')} onColorFamily={value => perform(() => changeColorFamily(value), false, 'appearance')} />
          <SettingsRow rowRef={methodsRow} label="Sign-in methods" icon="key" disabled={busy || expired} onPress={() => navigate('signInMethods')} />
          <AccountNotifications key={`account-notifications|${owner}`} session={session} push={push} busy={busy} onBusyChange={value => setSubmission(value, `${route.key}|notifications`)} />
          <MCPSettings key={`mcp-settings|${owner}`} session={session} busy={busy} onBusyChange={value => setSubmission(value, `${route.key}|mcp`)} />
        <View><SettingsRow label="Import from Splitwise" icon="import" disabled={busy} onPress={() => navigate('import')} />
          <ExportData key={`export-data|${owner}`} busy={busy} onExport={exportData} /></View>
        {!!unavailable.length && <Text style={[ui.notice, ui.warning]}>Access to {unavailable.length === 1 ? 'a group has' : 'some groups have'} ended. Saved work is kept for export.</Text>}
        {savedChangesView}
        <LegacyRecords groups={legacy} email={session.email} selected={legacySelf} busy={busy} onSelect={(id, person) => setLegacySelf(value => ({ ...value, [id]: person }))}
          onRecover={group => confirm('Recover to this account?', `${group.name} will be linked to ${session.email}. Original history is kept in recovery records.`, async () => {
            const result = await claimLegacyGroup(await getDatabase(), session, group.id, legacySelf[group.id], uuid);
            await load();
            if (result.status === 'conflict') { setNotice('These records need review. Their original copy is saved for export; server balances were not changed.', 'warning'); return; }
            await syncAccount(session); navigate('group', { groupId: group.id }); setNotice('Records recovered.', 'success');
          })}
          />
        {recoveries.some(value => value.status === 'conflict') && <Text style={[ui.notice, ui.warning]}>Some earlier records could not be safely combined. Use Export data to review their saved originals.</Text>}
        <View><SettingsRow label="Feedback" icon="feedback" disabled={busy || expired} onPress={() => setFeedbackOpen(true)} /><SettingsRow external label="Privacy" icon="privacy" disabled={busy} onPress={() => launch(() => Linking.openURL(`${APP_ORIGIN}/privacy`))} /><SettingsRow external label="Help and support" icon="help" disabled={busy} onPress={() => launch(() => Linking.openURL(`${APP_ORIGIN}/support`))} /></View>
        <View>

          <SettingsRow label="Sign out" icon="back" chevron={false} disabled={lock.current} onPress={() => confirm('Sign out?', storageIsDurable() ? 'Saved changes stay on this device for your next sign-in to this account.' : 'Export any temporary unsent changes before leaving. They will end when this tab closes.', async () => { await draftWrites.current; await flushChatWrites(); await endPushSession(session); await clearMediaPreviews(); await saveSession(null); changeScope(null); })} />
          <DeleteAccount email={session.email} busy={lock.current} onDelete={body => perform(() => deleteAccount(body))} />
        </View></View>
        <AppUpdates key={`app-updates|${owner}`} busy={busy} online={online} onRestart={restartUpdate} />
      </>}
    </ScrollView>}
    </SceneTransition>
    {showAddExpense && <AddExpenseButton disabled={busy} onPress={() => open(() => openExpense())} />}

    </>;
  }
  return <PhotoSession.Provider value={authHeld || expired ? null : session}><NavigationContainer ref={navigation.ref} linking={webLinking}><><AppFrame onTouchStart={engage} nativeTabs={usesNativeHomeTabs && !!session && screen === 'home'}><View ref={protectedContent} style={{ flex: 1 }} pointerEvents={authHeld ? 'none' : 'auto'} accessibilityElementsHidden={authHeld} importantForAccessibility={authHeld ? 'no-hide-descendants' : 'auto'} aria-hidden={authHeld}>
    <AppStack scope={`${owner}|${navigationScope}`} initialScreen={initialScreen.current} render={renderScreen} blocked={authHeld} />
  </View></AppFrame>
    {session && !authHeld && !expired && <UPISetupDialog key={`upi-setup|${owner}|${session.token}`} afterFirstSplit={upiAfterSplit} visible={upiSetup && !(appLink && 'groupInviteToken' in appLink) && !feedbackOpen && screen !== 'settle' && screen !== 'expense' && screen !== 'billChat' && screen !== 'expenseVersions'} busy={busy} needsName={!session.displayName?.trim()} onSaveName={value => saveName(value, true)} onSave={saveUPI} onSkip={() => setUpiSetup(false)} />}
    {session && !authHeld && !expired && <FeedbackDialog key={`feedback|${owner}|${session.token}`} visible={feedbackOpen} onClose={() => setFeedbackOpen(false)} onSubmit={async body => {
      const active = session;
      if (activeSessionRef.current?.token !== active.token || ownerRef.current !== accountOwner(active)) throw new Error('Sign in again.');
      const result = await request<{ id: string; saved: boolean }>(active, '/me/feedback', 'POST', body);
      if (activeSessionRef.current?.token !== active.token || ownerRef.current !== accountOwner(active) || result.id !== body.id || result.saved !== true) throw new Error('Could not confirm feedback.');
    }} />}
    {session && !authHeld && !expired && appLink && 'groupInviteToken' in appLink && <GroupJoinDialog key={`${session.token}|${appLink.groupInviteToken}`} session={session} token={appLink.groupInviteToken} onCancel={() => { forgetGroupInvite(); void saveGroupInvite(null).catch(() => {}); setAppLink(null); navigate(session ? 'home' : 'login'); }} onJoined={async id => {
      const active = session;
      if (activeSessionRef.current?.token !== active.token) return;
      const group = await fetchGroup(active, id);
      if (activeSessionRef.current?.token !== active.token) return;
      await saveGroup(await getDatabase(), accountOwner(active), group, 'shared');
      if (activeSessionRef.current?.token !== active.token) return;
      forgetGroupInvite(); void saveGroupInvite(null).catch(() => {}); setAppLink(null); navigate('group', { groupId: group.id, tab: 'Groups' }); await load(accountOwner(active));
    }} />}
    {newPersonInvite && <SendInviteDialog visible={showNewPersonInvite && !authHeld} email={newPersonInvite.email} busy={busy} error={newPersonInviteError} onSend={() => void sendNewPersonInvite()} onCancel={() => { if (!busy) { setNewPersonInvite(null); setNewPersonInviteError(''); } }} />}
    {authHeld && !!emailEntry && (emailEntry.phase === 'switch' ? emailContent : <EmailLinkDialog title={emailEntry.phase === 'name' ? 'Name' : 'Sign in'}>{emailContent}</EmailLinkDialog>)}
    {session && !authHeld && !expired && Platform.OS === 'web' && <OAuthContinuation key={`oauth-continuation|${owner}|${session.token}`} session={session} busy={busy} onSaveName={value => saveName(value, true)} beforeContinue={async () => { await draftWrites.current; }} />}
  </></NavigationContainer></PhotoSession.Provider>;
}
export default function App() { return <SafeAreaProvider initialMetrics={initialWindowMetrics}><UIProvider><AppContent /></UIProvider></SafeAreaProvider>; }
const makeStyles = (colors: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background }, loading: { alignItems: 'center', justifyContent: 'center', gap: 14 },
});
