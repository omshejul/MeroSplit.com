// Isolated manual/native QA entry. Production index.ts never imports this file.
import React, { useEffect, useRef, useState } from 'react';
import { Platform, ScrollView, View } from 'react-native';
import { Text } from 'react-native-paper';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppFrame, ScreenHeader, pageContentStyle } from '../../src/AppNavigation';
import AppStack, { NavigationContainer, useAppNavigation } from '../../src/AppStack';
import { UIProvider, Button, Icon, SettingsRow, useUI } from '../../src/ui';
import type { Group, Command, Session } from '../../src/types';
import { recalculateLocal, putLocalExpense } from '../fixtures';
import PersonRow, { PersonAmountRow } from '../../src/PersonRow';
import PersonChoice, { PersonSelectionList } from '../../src/PersonChoice';
import ChoiceGroup from '../../src/ChoiceGroup';
import { getDatabase } from '../../src/native';
import { expenseDraftStore } from '../../src/expenseDraft';
import PeopleSheet from '../../src/PeopleSheet';
import FieldDialog from '../../src/FieldDialog';
import { EmptyState, ErrorState, LoadingState, NoticeBanner } from '../../src/UIStates';
import PaginationFooter from '../../src/PaginationFooter';
import AttachmentPicker from '../../src/AttachmentPicker';
import AttachmentRow from '../../src/AttachmentRow';
import MediaPreviewFrame from '../../src/MediaPreviewFrame';
import OverflowMenu from '../../src/OverflowMenu';
import ResendControls from '../../src/ResendControls';
import AppLogo from '../../src/AppLogo';
import FloatingActionContainer from '../../src/FloatingActionContainer';
import BillSummary from '../../src/BillSummary';
import BillIconPicker from '../../src/BillIconPicker';
import { PersonDetailsFields, UPIAddressField } from '../../src/FormFields';
import GroupList from '../../src/GroupList';
import GroupScreen, { ExpenseDetail, PaymentDetail } from '../../src/GroupScreen';
import MembersScreen from '../../src/MembersScreen';
import ExpenseForm from '../../src/ExpenseForm';
import SettleForm from '../../src/SettleForm';
import ProfileSettings from '../../src/ProfileSettings';
import AccountNotifications from '../../src/AccountNotifications';
import MCPSettings from '../../src/MCPSettings';
import BillAttachments from '../../src/BillAttachments';
import ProfilePhoto from '../../src/ProfilePhoto';
import CreateGroupForm from '../../src/CreateGroupForm';
import ActivityScreen from '../../src/ActivityScreen';
import ExpenseVersionHistory from '../../src/ExpenseVersionHistory';
import SavedChangeScreen from '../../src/SavedChangeScreen';
import { SavedChanges, LegacyRecovery } from '../../src/AccountRecovery';
import GroupJoinDialog from '../../src/GroupJoinDialog';
import SignInLayout from '../../src/SignInLayout';
import { EmailSignIn, CodeSignIn } from '../../src/SignInForms';
import { EmailLinkSent } from '../../src/EmailLinkScreens';
import SignInMethods from '../../src/SignInMethods';
import { useLinkedProviders } from '../../src/useLinkedProviders';
import { readPrefetch, readScope } from '../../src/prefetch';
import GoogleBrandButton from '../../src/GoogleBrandButton';
import FeedbackDialog from '../../src/FeedbackDialog';
import SendInviteDialog from '../../src/SendInviteDialog';
import SwitchAccountDialog from '../../src/SwitchAccountDialog';
import UPISetupDialog from '../../src/UPISetupDialog';
import { PaymentHelpDialog } from '../../src/PaymentPanels';
import DeleteAccount from '../../src/DeleteAccount';
import SplitwiseImportScreen from '../../src/SplitwiseImportScreen';
import HomeTabs from '../../src/HomeTabs';

const session: Session = { userId: '99999', token: 'synthetic-component-qa', email: 'qa@example.invalid', baseUrl: Platform.OS === 'web' ? window.location.origin : 'https://ui-qa.invalid', displayName: 'Me' };
const base: Group = { id: 'component-qa', name: 'Weekend trip', owner_id: 99999, version: 1, participants: [{ id: 'a', name: 'Me', user_id: 99999 }, { id: 'b', name: 'Asha', user_id: 2 }, { id: 'c', name: 'Dev' }], expenses: [], settlements: [], balances: {}, transfers: [], activity: [], invites: [] };
const initial = putLocalExpense(base, { id: 'bill-qa', version: 1, description: 'Dinner with friends', total: '1001', paid: { a: '1001' }, split: { mode: 'equal', values: { a: '1', b: '1', c: '1' } }, date: '2026-10-28', notes: 'A synthetic bill for component QA.', category: 'food', deleted: false });
initial.settlements = [{ id: 'payment-qa', sender: 'b', recipient: 'a', amount: '100', date: '2026-10-28', provenance: 'manual' }];
const group = recalculateLocal(initial);
const command: Command = { command_id: 'saved-qa', group_id: group.id, method: 'POST', path: `/groups/${group.id}/expenses`, body: { ...group.expenses[0], id: 'new-saved-bill' }, state: 'pending', attempted: false, error: null };
let methods = { auto_link: true, accounts: [{ id: '1', provider: 'google', uid: 'google-qa', email: 'qa.google@example.invalid', can_disconnect: true }, { id: '2', provider: 'apple', uid: 'apple-qa', email: 'qa@privaterelay.appleid.com', can_disconnect: true }] };
let preferences = { expense_updates: true, email_reminders: true, notifications_enabled: true, email_available: true, push_device_ids: ['qa'] }, statement = { enabled: false, frequency: 'monthly', next_at: null, delivery: null as any }, connections = [{ id: 'agent-1', client_name: 'QA assistant' }];
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, options?: RequestInit) => {
  const url = new URL(typeof input === 'string' ? input : input.url, typeof window !== 'undefined' && window.location?.origin || session.baseUrl);
  if (url.origin !== session.baseUrl || !url.pathname.startsWith('/api/v1/')) return originalFetch(input, options);
  const path = url.pathname.replace(/^\/api\/v1/, ''), method = options?.method ?? 'GET', body = options?.body ? JSON.parse(String(options.body)) : {};
  let result: any;
  if (path === '/me/notifications/preferences') result = method === 'PUT' ? preferences = { ...preferences, ...body } : preferences;
  else if (path.includes('/me/balance-statements/preferences')) result = method === 'PUT' ? statement = { ...statement, ...body } : statement;
  else if (path.includes('/me/balance-statements/send')) result = { id: body.command_id, state: 'accepted' };
  else if (path === '/me/sign-in-methods') result = methods;
  else if (path === '/me/sign-in-methods/preferences') result = methods = { ...methods, ...body };
  else if (path.startsWith('/me/sign-in-methods/') && method === 'DELETE') result = methods = { ...methods, accounts: methods.accounts.filter(account => account.id !== path.split('/').pop()) };
  else if (path === '/me/mcp') result = { connections };
  else if (path.startsWith('/me/mcp/') && method === 'DELETE') { connections = []; result = {}; }
  else if (path === '/me') result = { avatar: null, profile_photo: null };
  else if (path.endsWith('/attachments')) { await new Promise(resolve => setTimeout(resolve, 1200)); result = { attachments: [{ id: 'receipt-qa', name: 'Dinner receipt.pdf', content_type: 'application/pdf', size: 16384 }], can_modify: true }; }
  else if (path === '/group-invite-links/preview') result = { name: group.name, already_member: false, version: group.version, people: group.participants.slice(1) };
  else if (path === '/group-invite-links/join') result = { id: group.id };
  else if (path.includes('/versions')) result = { group_id: group.id, expense_id: 'bill-qa', version: group.version, legacy_gap: false, next_before: null, items: [{ id: 'version-qa', sequence: 1, expense_id: 'bill-qa', actor_name: 'Me', created_at: '2026-10-28T09:00:00Z', via_mcp: false, currency: 'INR', names: { a: 'Me', b: 'Asha', c: 'Dev' }, changes: [{ field: 'total', before: '1000', after: '1001' }] }] };
  else return new Response(JSON.stringify({ detail: `Unconfigured QA route ${path}` }), { status: 404, headers: { 'Content-Type': 'application/json' } });
  return new Response(JSON.stringify(result), { status: 200, headers: { 'Content-Type': 'application/json' } });
}) as typeof fetch;

function ProviderMethodsDemo() { const connections = useLinkedProviders(session, true); return <SignInMethods session={session} busy={false} connections={connections} onGoogle={async () => {}} onApple={async () => {}} />; }

const pages = ['Rows', 'States', 'Selectors', 'Dialogs', 'Profile', 'Expense', 'Payment', 'Group', 'Members', 'Bill', 'Bill icons', 'Payment detail', 'Saved change', 'Recovery', 'Activity', 'Versions', 'Attachments', 'Photo', 'Create', 'Sign in', 'Providers', 'Notifications', 'MCP', 'Import', 'Tabs', 'Join'] as const;
type Page = typeof pages[number] | 'Home';
function Gallery() {
  const { ui, palette, changeAppearance, changeCurrency, changeColorFamily, dark } = useUI();
  const [page, setPage] = useState<Page>('Home'), [result, setResult] = useState('Ready'), [chosen, setChosen] = useState('a'), [open, setOpen] = useState(false), [failed, setFailed] = useState(false), [dialog, setDialog] = useState(''), [value, setValue] = useState('Asha'), [email, setEmail] = useState('asha@example.invalid'), [tab, setTab] = useState('Groups');
  const writes = useRef(Promise.resolve()), [members, setMembers] = useState(group), [name, setName] = useState('Me'), [vpa, setVpa] = useState('');
  useEffect(() => { if (page === 'Expense') void expenseDraftStore('component-gallery-qa', group.id, null, writes, getDatabase).read().catch(cause => setResult(`QA storage: ${String(cause)}`)); }, [page]);
  const done = (label: string) => { setResult(label); setDialog(''); setOpen(false); };
  const push: any = { state: { ready: true, enabled: false, optedIn: false, pendingOff: false, installationId: 'qa', permission: 'granted', working: false, error: '' }, enable: async () => true, disable: async () => {}, refresh: async () => {} };
  let content: React.ReactNode;
  if (page === 'Home') content = <>{pages.map(item => <Button key={item} title={item} onPress={() => { setPage(item); setResult('Ready'); }} />)}</>;
  if (page === 'Rows') content = <><AppLogo size={40} /><PersonRow name="Asha" trailing={<Button title="Manage Asha" onPress={() => done('Managed Asha')} />}><Text style={ui.caption}>Organizer</Text></PersonRow><PersonAmountRow name="Dev" amount="0" /><PersonAmountRow name="Asha" amount="-1" /><BillSummary title="Dinner" amount="1001"><Text style={ui.caption}>28 Oct · 3 people</Text></BillSummary><AttachmentRow title="Receipt.pdf" subtitle="PDF · 1 KB" label="Open QA receipt" thumbnail={<MediaPreviewFrame label="PDF preview" text="PDF" />} disabled={false} onOpen={() => done('Opened receipt')} /><OverflowMenu open={open} disabled={false} label="QA options" onOpen={() => { setOpen(true); setResult('Menu opened'); }} onClose={() => { setOpen(false); setResult('Menu closed'); }}><Button title="Report QA message" kind="menu" onPress={() => done('Reported message')} /></OverflowMenu><ResendControls busy={false} resendSeconds={0} onResend={() => done('Resent code')} onChangeEmail={() => done('Changed email')} /><GroupList groups={[{ kind: 'shared', group }]} commands={[]} userId={session.userId} busy={false} direct={false} onOpen={() => setPage('Group')} /></>;
  if (page === 'States') content = <><NoticeBanner tone="warning">Pending sync</NoticeBanner><NoticeBanner tone="success">Saved</NoticeBanner><ErrorState error="Connection unavailable" onRetry={() => done('Retried connection')} /><EmptyState message="No bills yet" illustration={<Icon name="bill" />} /><LoadingState label="Loading files…" spinner /><PaginationFooter paging={{ canLoadMore: true, loading: false, failed, loadMore: () => { setFailed(true); setResult('Load failed'); }, retry: () => { setFailed(false); setResult('Retried page'); } }} /><MediaPreviewFrame label="Retry QA preview" text="Retry" onRetry={() => done('Retried preview')} /><AttachmentPicker disabled={false} onPick={photo => done(photo ? 'Picked Photo' : 'Picked Files')} /></>;
  if (page === 'Selectors') content = <><PersonChoice person={group.participants[0]} title="Me" amount="₹3.34" selected={chosen === 'a'} disabled={false} onPress={() => setChosen(chosen === 'a' ? '' : 'a')} /><PersonSelectionList people={group.participants} selected={chosen} onSelect={id => { setChosen(id); setResult(`Selected ${id}`); }} /><ChoiceGroup label="Split method" group="qa-method" options={[{ value: 'equal', label: 'Equally' }, { value: 'exact', label: 'Exact amounts' }]} selected={value} disabled={false} onChoose={setValue} /><PersonDetailsFields name={{ label: 'Their name', value, onChangeText: setValue }} email={{ label: 'Optional email', value: email, onChangeText: setEmail }} /><UPIAddressField label="UPI ID" value={vpa} onChangeText={setVpa} /><Button title="Edit field" onPress={() => setOpen(true)} /><FieldDialog visible={open} title="Edit QA name" disabled={false} canSave={!!value.trim()} onClose={() => setOpen(false)} onSave={() => done(`Saved ${value}`)}><PersonDetailsFields name={{ label: 'Name', value, onChangeText: setValue }} email={{ label: 'Email', value: email, onChangeText: setEmail }} /></FieldDialog></>;
  if (page === 'Dialogs') content = <>{['People', 'Feedback', 'Invite', 'Switch', 'UPI', 'Help'].map(item => <Button key={item} title={`Open ${item}`} onPress={() => setDialog(item)} />)}<PeopleSheet visible={dialog === 'People'} title="Who paid?" icon="pay" total="₹10.01" count={3} disabled={false} maxHeight={800} onDismiss={() => setDialog('')}>{group.participants.map(person => <PersonChoice key={person.id} person={person} title={person.name} selected disabled={false} onPress={() => {}} />)}</PeopleSheet><DeleteAccount email={session.email} busy={false} onDelete={async () => done('QA delete callback')} /><FeedbackDialog visible={dialog === 'Feedback'} onClose={() => setDialog('')} onSubmit={async () => done('Feedback submitted')} /><SendInviteDialog visible={dialog === 'Invite'} email={email} busy={false} error="" onSend={() => done('Invite sent')} onCancel={() => setDialog('')} />{dialog === 'Switch' && <SwitchAccountDialog currentEmail={session.email} targetEmail={email} invitation busy={false} onSwitch={() => done('Switched QA account')} onCancel={() => setDialog('')} />}<UPISetupDialog visible={dialog === 'UPI'} busy={false} needsName={false} onSaveName={async () => {}} onSave={async text => { setVpa(text); done('UPI saved'); }} onSkip={() => setDialog('')} /><PaymentHelpDialog visible={dialog === 'Help'} name="Asha" vpa="asha@bank" onClose={() => setDialog('')} /></>;
  if (page === 'Profile') content = <View><ProfileSettings name={name} vpa={vpa} busy={false} onSaveName={async value => { setName(value); setResult(`Name ${value}`); }} onSaveUPI={async value => { setVpa(value); setResult(`UPI ${value}`); }} onAppearance={changeAppearance} onColorFamily={changeColorFamily} onCurrency={changeCurrency} /><SettingsRow icon="key" label="Sign-in methods" onPress={() => setPage('Providers')} /></View>;
  if (page === 'Expense') content = <ExpenseForm group={group} selfId="a" busy={false} owner="component-gallery-qa" writes={writes} onSave={async value => { setResult(`Saved bill ${value.total}`); }} />;
  if (page === 'Payment') content = <SettleForm group={group} selfId="a" busy={false} initial={group.transfers[0]} onSave={async payment => done(`Recorded ${payment.amount}`)} onCancel={() => setPage('Home')} onReviewAttempt={async () => {}} onPrepareUPI={async () => { throw Error('QA does not launch payments'); }} onCancelUPI={async () => {}} returnPayment={null} onArmReturn={async () => { throw Error('QA does not launch payments'); }} onReturnPaymentChange={async () => {}} onResolveReturn={async () => {}} />;
  if (page === 'Group') content = <GroupScreen group={group} accepted={group} pending={[]} selfId="a" busy={false} onExpense={() => setPage('Bill')} onPayment={() => setPage('Payment detail')} onSettle={() => setPage('Payment')} onReverse={() => done('Reversal callback')} onLoadBalanceGroup={async expected => ({ group: expected, saved: true })} />;
  if (page === 'Members') content = <MembersScreen group={members} selfId="a" busy={false} addPersonRequest={open ? 1 : 0} onMembership={() => done('Membership callback')} onAction={async (path, body) => { if (path === '/participants') setMembers(current => ({ ...current, participants: [...current.participants, { id: String(body.id), name: String(body.name) }] })); setResult(`Member action ${path}`); return { id: group.id, version: group.version, pending: true }; }} />;
  if (page === 'Bill icons') content = <BillIconPicker category={members.expenses[0].category} onClose={() => setPage('Bill')} onSelect={async (category, onQueued) => { setMembers(current => ({ ...current, expenses: current.expenses.map((expense, i) => i === 0 ? { ...expense, category, category_auto: false } : expense) })); onQueued(); }} />;
  if (page === 'Bill') content = <ExpenseDetail onIconPress={() => setPage('Bill icons')} group={members} expense={members.expenses[0]} selfId="a" busy={false} canEdit onEdit={() => setPage('Expense')} onReverse={() => done('Reverse bill callback')} onHistory={() => setPage('Versions')} />;
  if (page === 'Payment detail') content = <PaymentDetail group={group} payment={group.settlements[0]} selfId="a" busy={false} canReverse onReverse={() => done('Reverse payment callback')} />;
  if (page === 'Saved change') content = <SavedChangeScreen command={command} group={group} busy={false} onDiscard={() => done('Discarded saved change')} onEditSaved={() => setPage('Expense')} />;
  if (page === 'Recovery') content = <><SavedChanges expanded commands={[command]} groups={[{ kind: 'shared', group }]} busy={false} expired={false} onOpen={() => setPage('Group')} onReview={() => setPage('Saved change')} onDiscard={() => done('Discarded change')} onRetry={() => done('Retried sync')} /><LegacyRecovery groups={[group]} email={session.email} selected={{ [group.id]: chosen }} busy={false} onSelect={(_, id) => setChosen(id)} onRecover={() => done('Recovered QA records')} /></>;
  if (page === 'Activity') content = <ActivityScreen items={[{ id: 'activity-qa', kind: 'bill_added', created_at: '2026-10-28T09:00:00Z', group: { id: group.id, name: group.name }, actor: { name: 'Me', is_self: true }, bill: { id: 'bill-qa', description: 'Dinner with friends', deleted: false } }]} busy={false} onRefresh={() => done('Refreshed activity')} onOpen={() => setPage('Bill')} />;
  if (page === 'Versions') content = <ExpenseVersionHistory session={session} groupId={group.id} expenseId="bill-qa" groupVersion={group.version} title="Dinner with friends" active online onInvalidated={() => setResult('History invalidated')} />;
  if (page === 'Attachments') content = <BillAttachments session={session} groupId={group.id} expenseId="bill-qa" busy={false} onBusyChange={() => {}} />;
  if (page === 'Photo') content = <ProfilePhoto session={session} busy={false} onBusyChange={() => {}} />;
  if (page === 'Create') content = <CreateGroupForm direct={false} busy={false} onCreate={value => done(`Created ${value.name}`)} />;
  if (page === 'Sign in') content = <><EmailSignIn email={email} busy={false} onEmail={setEmail} onSend={() => done('Sent sign-in code')}><GoogleBrandButton disabled={false} onPress={() => done('Google callback')} /></EmailSignIn><CodeSignIn email={email} code={value} busy={false} resendSeconds={0} onCode={setValue} onConfirm={() => done('Confirmed code')} onResend={() => done('Resent code')} onChangeEmail={() => done('Changed email')} /><EmailLinkSent busy={false} resendSeconds={0} onResend={() => done('Resent link')} onCode={() => done('Chose code')} onChangeEmail={() => done('Changed email')} /></>;
  if (page === 'Providers') content = <ProviderMethodsDemo />;
  if (page === 'Notifications') content = <AccountNotifications session={session} push={push} busy={false} onBusyChange={() => {}} />;
  if (page === 'MCP') content = <MCPSettings session={session} busy={false} onBusyChange={() => {}} />;
  if (page === 'Import') content = <SplitwiseImportScreen session={session} busy={false} onBusyChange={() => {}} onCancel={() => setPage('Home')} onImported={() => done('Imported fixture')} />;
  if (page === 'Tabs') content = <HomeTabs selected={tab} busy={false} onSelect={setTab} render={selected => <Text style={ui.section}>{selected} content</Text>} />;
  if (page === 'Join') content = <GroupJoinDialog session={session} token={'a'.repeat(64)} onJoined={async () => { setPage('Group'); setResult('Joined fixture'); }} onCancel={() => setPage('Home')} />;
  const virtualized = ['Group', 'Activity', 'Versions', 'Tabs', 'Bill icons'].includes(page);
  return <AppFrame><ScreenHeader title={`QA ${page}`} showTitle={page !== 'Bill'} busy={false} onBack={page === 'Home' ? undefined : () => { setPage('Home'); setOpen(false); setDialog(''); }}><Button title={dark ? 'Light' : 'Dark'} onPress={() => void changeAppearance(dark ? 'light' : 'dark')} /></ScreenHeader><Text accessibilityLiveRegion="polite" style={[ui.caption, { paddingHorizontal: 16 }]}>{result}</Text>
    {page === 'Sign in' ? <SignInLayout busy={false}>{content}</SignInLayout> : virtualized ? content : <ScrollView key={page} keyboardShouldPersistTaps="handled" contentContainerStyle={pageContentStyle}>{page === 'Members' && <Button title="Add person" onPress={() => setOpen(true)} />}{content}</ScrollView>}
    {page === 'Rows' && <FloatingActionContainer><Button title="QA floating action" onPress={() => done('Floating action')} /></FloatingActionContainer>}
  </AppFrame>;
}
function GalleryStack() { const navigation = useAppNavigation(); return <NavigationContainer ref={navigation.ref}><AppStack initialScreen="home" scope="component-gallery" blocked={false} render={() => <Gallery />} /></NavigationContainer>; }
export default function ComponentGallery() { useEffect(() => { readPrefetch.configure(readScope(session), true); return () => readPrefetch.configure('', false); }, []); return <SafeAreaProvider><UIProvider><GalleryStack /></UIProvider></SafeAreaProvider>; }
