// Synthetic acceptance entry. Never imported by production index.ts.
import React, { useEffect, useState } from 'react';
import { registerRootComponent } from 'expo';
import * as SplashScreen from 'expo-splash-screen';
import { File, Paths } from 'expo-file-system';
import { Platform, View } from 'react-native';
import { Text } from 'react-native-paper';
import { SafeAreaProvider, initialWindowMetrics } from 'react-native-safe-area-context';
import { UIProvider, useUI, Button } from '../../src/ui';
import { LoadingProvider } from '../../src/LoadingOverlay';
import { PhotoSession } from '../../src/Avatar';
import { ToastProvider } from '../../src/Toast';
import KeyboardScrollView from '../../src/KeyboardScrollView';
import MembersScreen from '../../src/MembersScreen';
import GroupList from '../../src/GroupList';
import AccountHeader from '../../src/AccountHeader';
import ActivityScreen from '../../src/ActivityScreen';
import type { Group, Session, ActivityItem } from '../../src/types';

const session: Session = { baseUrl: Platform.OS === 'web' ? window.location.origin : 'https://group-identity-qa.invalid', token: 'synthetic-only', userId: '2', email: 'qa@example.invalid' };
const meta = (id: string) => ({ id, name: 'Group photo.jpg', content_type: 'image/jpeg', size: 1200 });
let photo: ReturnType<typeof meta> | null = null, fail = false;
const writes: unknown[] = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input); if (!url.startsWith(session.baseUrl)) return originalFetch(input, init);
  await new Promise(resolve => setTimeout(resolve, 200));
  const method = init?.method ?? 'GET';
  if (url.endsWith('/photo')) {
    if (method === 'POST') {
      if (fail) throw Error('Synthetic upload interruption');
      const form = init?.body as any;
      photo = meta(form.get?.('id') ?? form.getParts?.().find((p: any) => p.fieldName === 'id')?.string ?? 'photo');
      writes.push({ photo });
    }
    return Response.json({ group_photo: photo });
  }
  if (url.includes('/photo/') && method === 'DELETE') { photo = null; writes.push({ removed: true }); return Response.json({ removed: true }); }
  if (url.endsWith('/me')) return Response.json({ avatar: null });
  if (url.includes('/media/')) return Response.json({ url: 'https://merosplit.com/app/icon-512.png', expires_at: new Date(Date.now() + 300_000).toISOString() });
  throw Error('Unexpected synthetic request');
};
const initial: Group = { id: 'identity-group', name: 'Goa trip', version: 1, owner_id: 1, is_direct: false, group_photo: null, simplify_debts: true, can_change_simplify: true,
  participants: [{ id: 'om', name: 'Om', user_id: 1 }, { id: 'self', name: 'Anish', user_id: 2 }, { id: 'guest', name: 'Harshit', user_id: null }, { id: 'aryan', name: 'Aryan', user_id: 3 }],
  expenses: [], settlements: [], balances: { om: '0', self: '0', guest: '0', aryan: '0' }, transfers: [], activity: [] };
function Probe() {
  const { ui, changeColorFamily } = useUI(), [group, setGroup] = useState(initial), [page, setPage] = useState('settings'), [activity, setActivity] = useState<ActivityItem[]>([]);
  const update = async (path: string, body: Record<string, unknown>) => {
    writes.push({ path, body }); await new Promise(resolve => setTimeout(resolve, 250));
    if (fail) throw Error('Could not save. Check your connection and try again.');
    const before = path === '/name' ? group.name : group.participants.find(p => path.includes(p.id))?.name ?? '';
    const after = String(body.name || 'Harshit');
    setGroup(previous => ({ ...previous, version: previous.version + 1, ...(path === '/name' ? { name: after } : { participants: previous.participants.map(p => path.includes(`/participants/${p.id}/`) ? { ...p, name: after } : p) }) }));
    setActivity(previous => [{ id: String(writes.length), kind: path === '/name' ? 'group_renamed' : 'member_nickname_changed', created_at: new Date().toISOString(), group: { id: group.id, name: group.name }, actor: { name: 'Anish', is_self: true }, name_change: { before, after }, ...(path !== '/name' ? { person: { id: 'om', name: after, is_self: false } } : {}) }, ...previous]);
    return { id: group.id, version: group.version + 1 };
  };
  useEffect(() => { void SplashScreen.hideAsync(); if (Platform.OS === 'web') void changeColorFamily('obsidian'); }, [changeColorFamily]);
  useEffect(() => {
    if (Platform.OS === 'web') { (globalThis as any).groupFixture = { writes, setPage, fail: (value: boolean) => { fail = value; } }; return; }
    new File(Paths.document, 'identity-state').write(JSON.stringify({ group, writes, page, activity }));
  }, [group, page, activity]);
  useEffect(() => {
    if (Platform.OS === 'web') return;
    const command = new File(Paths.document, 'identity-command');
    const timer = setInterval(() => {
      if (!command.exists) return; const value = command.textSync().trim(); command.delete();
      if (value === 'fail') fail = true;
      else if (value === 'ready') fail = false;
      else if (value === 'archived') setGroup(previous => ({ ...previous, archived: !previous.archived }));
      else if (value === 'long') setGroup(previous => ({ ...previous, name: 'Weekend plans with friends and family in Goa', participants: previous.participants.map(p => ({ ...p, name: p.id === 'om' ? 'Om Shejul with a longer display name' : p.name })) }));
      else setPage(value);
    }, 150);
    return () => clearInterval(timer);
  }, []);
  return <View style={{ flex: 1 }}>
    <View style={{ padding: 16, paddingTop: 44 }}><Text style={ui.section}>Group settings</Text></View>
    {page === 'activity' ? <ActivityScreen items={activity} busy={false} onRefresh={() => {}} onOpen={() => {}} /> : <KeyboardScrollView contentContainerStyle={{ padding: 16 }}>
      {page === 'settings' ? <MembersScreen session={session} group={group} selfId="self" busy={false} onAction={update} onMembership={() => {}} onPhotoChanged={() => setGroup(previous => ({ ...previous, version: previous.version + 1, group_photo: photo }))} />
        : page === 'account' ? <AccountHeader session={session} name="Anish" busy={false} onBusyChange={() => {}} />
        : <GroupList groups={[{ group, kind: 'shared' }]} commands={[]} busy={false} userId="2" direct={false} onOpen={() => setPage('settings')} />}
      {Platform.OS === 'web' && <Button title="Show activity" onPress={() => setPage('activity')} />}
    </KeyboardScrollView>}
  </View>;
}
registerRootComponent(() => <SafeAreaProvider initialMetrics={initialWindowMetrics}><UIProvider><LoadingProvider><ToastProvider><PhotoSession.Provider value={session}><Probe /></PhotoSession.Provider></ToastProvider></LoadingProvider></UIProvider></SafeAreaProvider>);
