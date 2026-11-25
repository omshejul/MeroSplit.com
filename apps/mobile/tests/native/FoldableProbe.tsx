// Test-only full-app entry. Production index.ts must never import this file.
// Isolated QA index: import './tests/native/FoldableProbe'; use no Sentry DSN or OTA.
import React, { useEffect, useState } from 'react';
import { Text } from 'react-native';
import { registerRootComponent } from 'expo';
import * as SplashScreen from 'expo-splash-screen';
import { File, Paths } from 'expo-file-system';
import { accountOwner } from '../../src/api';
import { getDatabase, savedSession, saveSession, claimFirstSplitUPIPrompt, claimPushInvitation } from '../../src/native';
import { saveGroup, readGroup, saveExpenseHistory } from '../../src/storage';
import { emptyGroup, previewPending } from '../../src/ledger';
import { recordConnection } from '../../src/connectivity';
import { putLocalExpense } from '../fixtures';
import type { Group, Session, ActivityItem, Command } from '../../src/types';
import type { ChatMessage } from '../../src/billChat';
import type { Channels } from '../../src/channelPreferences';

const session: Session = { baseUrl: 'https://foldable-probe.invalid', userId: '99999', token: 'synthetic-foldable-probe-only', email: 'om@example.invalid', displayName: 'Om' };
const id = (n: number) => `f01d0000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const people = ['Om', 'Asha', 'Dev', 'Mira'].map((name, i) => ({ id: id(i + 1), name, recorded_name: name, account_email: `${name.toLowerCase()}@example.invalid`, user_id: i ? 99999 + i : 99999 }));
function sample(index: number, name: string, bills: [string, number, number, string][], direct = false): Group {
  let g = { ...emptyGroup(id(100 + index), name, direct ? people.slice(0, 2) : people), owner_id: 99999, attribution_version: 1, simplify_debts: true, can_change_simplify: true, is_direct: direct, invites: [] } as Group;
  bills.forEach(([description, rupees, payer, category], i) => {
    g = putLocalExpense(g, { id: id(1000 + index * 100 + i), version: 1, description, total: String(rupees * 100), paid: { [people[payer].id]: String(rupees * 100) }, split: { mode: 'equal', values: Object.fromEntries(g.participants.map(p => [p.id, '1'])) }, date: `2026-11-${String(25 - i).padStart(2, '0')}`, created_at: `2026-11-${String(25 - i).padStart(2, '0')}T12:00:00Z`, category, category_auto: false, notes: i ? '' : 'A lovely weekend together.\n\n| Person | Share |\n| --- | --- |\n| Everyone | Equal |', deleted: false });
  });
  return g;
}
let groups = [sample(0, 'Goa weekend', [['Beachside dinner', 3200, 0, 'food'], ['Stay by the beach', 12000, 1, 'hotel'], ['Taxi to the airport', 2400, 2, 'taxi'], ['Sunset ferry', 800, 3, 'travel'], ['Breakfast and coffee', 960, 0, 'coffee'], ['Snacks for the road', 640, 2, 'groceries']]), sample(1, 'Apartment bills', [['November groceries', 4200, 0, 'groceries'], ['Internet', 1200, 0, 'internet'], ['Electricity', 2400, 2, 'electricity']]), sample(2, 'Asha', [['Lunch together', 1600, 0, 'food']], true)];
let receipts: Record<string, unknown> = {}, chats: Record<string, ChatMessage[]> = {}, offline = false;
let channels: Channels = { email_notifications: true, email_available: true, legacy_muted: false, statement_enabled: true, statement_frequency: 'monthly', muted_push_devices: [] };
const server = new File(Paths.document, 'foldable-probe-server-v1.json');
const persist = () => server.write(JSON.stringify({ groups, receipts, chats }));
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const transactions = (g: Group) => [...g.expenses.map(bill => ({ kind: 'bill' as const, date: bill.date, bill })), ...g.settlements.map(payment => ({ kind: 'payment' as const, date: payment.date ?? null, payment }))].sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
function summary(g: Group): Group {
  const paid = Object.fromEntries(g.participants.map(p => [p.id, '0'])), shares = { ...paid };
  let spending = 0n;
  for (const bill of g.expenses.filter(e => !e.deleted)) {
    spending += BigInt(bill.total);
    for (const p of g.participants) { paid[p.id] = String(BigInt(paid[p.id]) + BigInt(bill.paid[p.id] ?? '0')); shares[p.id] = String(BigInt(shares[p.id]) + BigInt(bill.shares[p.id] ?? '0')); }
  }
  return { ...g, read_mode: 'summary', expenses: [], settlements: [], transactions: transactions(g), history: { transactions: { next_cursor: null }, bills: { next_cursor: null }, settlements: { next_cursor: null }, activity: { next_cursor: null }, attempts: { next_cursor: null } }, totals: { spending: String(spending), paid, shares } };
}
const history = (g: Group, expenseId: string) => ({ group_id: g.id, expense_id: expenseId, version: g.version, items: [], next_before: null, legacy_gap: false });
function activity(): ActivityItem[] {
  return groups.flatMap(g => g.expenses.map(b => ({ id: b.id, kind: 'bill_added' as const, created_at: b.created_at ?? `${b.date}T12:00:00Z`, group: { id: g.id, name: g.name }, actor: { name: g.participants.find(p => b.paid[p.id] && b.paid[p.id] !== '0')?.name ?? 'Om', is_self: BigInt(b.paid[people[0].id] ?? '0') > 0n }, bill: { id: b.id, description: b.description, deleted: b.deleted, category: b.category, category_auto: false } }))).sort((a, b) => b.created_at.localeCompare(a.created_at));
}

// No original-fetch fallback. Unknown origins are rejected before touching a network.
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (url.origin !== session.baseUrl) throw new Error(`Foldable probe blocked external HTTP: ${url.origin}`);
  if (offline) throw new Error('Synthetic offline mode');
  if (init?.signal?.aborted) throw new Error('Synthetic request cancelled');
  const path = url.pathname.replace(/^\/api\/v1/, ''), method = init?.method ?? 'GET';
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, any> : {};
  const parts = path.split('/').filter(Boolean), g = groups.find(value => value.id === parts[1]);
  const heads = groups.map(value => ({ id: value.id, version: value.version, hidden: !!value.hidden }));
  if (path === '/app-releases') return json({ ios: { version: '1.0.0', build: '1' }, android: { version: '1.0.0', build: '1' } });
  if (path === '/me') return json({ id: 99999, display_name: session.displayName, payment_profile: { vpa: 'om@demo', version: 1, bank_verified: false }, avatar: null, profile_photo: null });
  if (path === '/me/profile') { session.displayName = String(body.display_name); return json({ display_name: session.displayName }); }
  if (path === '/groups' && method === 'GET' || path === '/me/ledger-heads') return json({ groups: heads, profile_photos: {} });
  if (path === '/activity') return json({ read_mode: 'activity', revision: heads.map(h => h.version).join('.'), items: activity(), next_cursor: null });
  if (path === '/me/bill-email-entry') return json({ needs_invitation: false });
  if (path === '/me/notifications/channels') { if (method === 'PUT') channels = { ...channels, ...body, statement_enabled: body.email_notifications ?? channels.email_notifications }; return json({ ...channels, revision: body.revision }); }
  if (path === '/me/notifications/preferences') return json({ expense_updates: true, email_reminders: channels.email_notifications, notifications_enabled: true, email_available: true, push_device_ids: [] });
  if (path === '/me/balance-statements/preferences') return json({ enabled: channels.email_notifications, frequency: channels.statement_frequency, next_at: null, delivery: null });
  if (path === '/me/sign-in-methods') return json({ auto_link: true, accounts: [] });
  if (path === '/me/mcp') return json({ connections: [] });
  if (path === '/me/chat-conversations') return json({ conversations: [], next_cursor: null });
  if (path === '/me/notifications' || path === '/me/chat-notifications') return json({ notices: [], has_more: false });
  if (path.startsWith('/me/notifications/') && method === 'POST') return json({ seen: [] });
  if (path === '/expense-icons') return json({ items: groups.flatMap(value => value.expenses.map(e => ({ id: e.id, group_id: value.id, title: e.description, category: e.category, state: 'manual' }))) });
  if (g && method === 'GET') {
    if (parts.length === 2) return json(g);
    if (parts[2] === 'summary') return json(summary(g));
    if (parts[2] === 'history') {
      const q = (url.searchParams.get('q') ?? '').toLowerCase();
      return json({ read_mode: 'page', group_id: g.id, version: g.version, items: parts[3] === 'transactions' ? transactions(g).filter(t => t.kind !== 'bill' || t.bill.description.toLowerCase().includes(q)) : parts[3] === 'bills' ? g.expenses : parts[3] === 'settlements' ? g.settlements : [], next_cursor: null });
    }
    if (parts[2] === 'expenses') {
      if (parts[4] === 'attachments') return json({ attachments: [], can_modify: true });
      if (parts[4] === 'versions') return json(history(g, parts[3]));
      if (parts[4] === 'chat' && parts[5] === 'status') return json({ unread: 0 });
      if (parts[4] === 'chat') return json({ messages: chats[path] ?? [], older_cursor: null, after_cursor: '0', has_more_newer: false, removed_ids: [], unread: 0, can_send: true, policy_accepted: true, policy_version: 1, blocked_users: [] });
      const bill = g.expenses.find(e => e.id === parts[3]);
      if (bill) return json({ ...bill, group_id: g.id, group_version: g.version });
    }
    if (parts[2] === 'settlements') { const payment = g.settlements.find(p => p.id === parts[3]); if (payment) return json({ ...payment, group_id: g.id, group_version: g.version }); }
  }
  if (g && parts[4] === 'chat' && method === 'POST') {
    if (parts[5] === 'seen') return json({ seen: body.tokens?.length ?? 0 });
    const messages = chats[path] ??= [], prior = messages.find(m => m.client_id === body.client_id);
    const message = prior ?? { id: String(messages.length + 1), client_id: String(body.client_id), sender_id: session.userId, sender: 'Om', text: String(body.text), hidden: false, created_at: new Date().toISOString(), seen_token: id(9000 + messages.length) };
    if (!prior) messages.push(message); persist(); return json(message);
  }
  if (body.command_id && receipts[body.command_id]) return json(receipts[body.command_id]);
  if (path === '/groups' && method === 'POST') {
    groups.push({ ...emptyGroup(body.id, body.name, body.participants.map((p: any) => ({ ...p, recorded_name: p.name, account_email: null, user_id: p.id === body.self_participant_id ? 99999 : null }))), version: 1, owner_id: 99999, attribution_version: 1, simplify_debts: true, is_direct: !!body.is_direct });
  } else if (g && ['POST', 'PUT', 'DELETE'].includes(method) && /\/(expenses|settlements|participants|name)(\/|$)/.test(path)) {
    try {
      const updated = previewPending(g, [{ command_id: body.command_id, group_id: g.id, method: method as Command['method'], path, body, state: 'pending', error: null }]);
      updated.version++; updated.expenses = updated.expenses.map(e => e.id === body.id ? { ...e, created_at: e.created_at ?? new Date().toISOString(), version: (g.expenses.find(old => old.id === e.id)?.version ?? 0) + 1 } : e);
      groups = groups.map(value => value.id === g.id ? updated : value);
    } catch (cause) { return json({ detail: String(cause) }, 422); }
  } else return json({ detail: `Unconfigured synthetic route: ${method} ${path}` }, 501);
  const accepted = { id: g?.id ?? body.id, version: groups.find(value => value.id === (g?.id ?? body.id))?.version };
  if (body.command_id) receipts[body.command_id] = accepted; persist(); return json(accepted);
};

let preparation: Promise<void> | undefined;
async function prepare() {
  if (process.env.EXPO_PUBLIC_SENTRY_DSN) throw new Error('Use an isolated QA build with an empty EXPO_PUBLIC_SENTRY_DSN.');
  const prior = await savedSession();
  if (prior && prior.baseUrl !== session.baseUrl) throw new Error('Install this fixture into a clean QA app. Existing account was preserved.');
  if (server.exists) { const stored = JSON.parse(server.textSync()); groups = stored.groups; receipts = stored.receipts; chats = stored.chats; } else persist();
  const db = await getDatabase(), owner = accountOwner(session);
  for (const g of groups) if (!await readGroup(db, owner, g.id)) {
    await saveGroup(db, owner, g, 'shared'); await saveGroup(db, owner, summary(g), 'shared');
    for (const e of g.expenses) await saveExpenseHistory(db, owner, g.id, e.id, history(g, e.id));
  }
  await Promise.all([saveSession(session), claimFirstSplitUPIPrompt(owner), claimPushInvitation(owner)]);
  new File(Paths.document, 'foldable-probe-provenance.json').write(JSON.stringify({ entry: 'tests/native/FoldableProbe.tsx', app: 'App.tsx', sourceRevision: process.env.EXPO_PUBLIC_FOLDABLE_PROBE_REVISION ?? 'unset', syntheticOrigin: session.baseUrl, groups: groups.map(g => ({ id: g.id, name: g.name })), preparedAt: new Date().toISOString() }));
}
export default function FoldableProbe() {
  const [ready, setReady] = useState(false), [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    preparation ??= prepare();
    void preparation.then(() => { if (alive) setReady(true); }).catch(cause => { if (alive) setError(String(cause)); void SplashScreen.hideAsync(); });
    return () => { alive = false; };
  }, []);
  useEffect(() => {
    if (!ready) return;
    const command = new File(Paths.document, 'foldable-probe-command');
    const timer = setInterval(() => { if (command.exists) { const value = command.textSync().trim(); command.delete(); if (value === 'offline' || value === 'online') { offline = value === 'offline'; recordConnection(!offline); } } }, 500);
    return () => clearInterval(timer);
  }, [ready]);
  if (error) return <Text accessibilityRole="alert">{error}</Text>;
  const App = ready ? require('../../App').default as React.ComponentType : null;
  return App ? <App /> : null;
}
registerRootComponent(FoldableProbe);
