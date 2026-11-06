// Synthetic native acceptance entry. Never imported by production index.ts.
import React, { useEffect, useRef, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { Text } from 'react-native-paper';
import { registerRootComponent } from 'expo';
import * as SplashScreen from 'expo-splash-screen';
import { SafeAreaProvider, initialWindowMetrics } from 'react-native-safe-area-context';
import { UIProvider, Button } from '../../src/ui';
import { LoadingProvider } from '../../src/LoadingOverlay';
import { AppFrame } from '../../src/AppNavigation';
import AppStack, { NavigationContainer } from '../../src/AppStack';
import ExpenseForm from '../../src/ExpenseForm';
import SettleForm from '../../src/SettleForm';
import { getDatabase } from '../../src/native';
import { enqueue, enqueueBill, pendingCommands, saveGroup } from '../../src/storage';
import { accountOwner, syncOutbox } from '../../src/api';
import type { Command, Expense, Group, Session } from '../../src/types';
const session: Session = { token: 'synthetic', userId: 'native-edge', email: '', baseUrl: 'https://native-edge.invalid' };
const owner = accountOwner(session);
const expense: Expense = { id: 'historical', version: 3, description: 'Historical dinner', total: '1000', paid: { a: '500', b: '500' }, shares: { a: '500', b: '500' }, split: { mode: 'equal', values: { a: '1', b: '1' } }, date: '2026-01-01', category: 'food', notes: '', deleted: false };
const group: Group = { id: 'native-edge', name: 'Synthetic trip', version: 4, participants: [{ id: 'a', name: 'Asha', user_id: 1 }, { id: 'b', name: 'Bharat', user_id: 2 }], expenses: [], settlements: [], balances: { a: '-1000', b: '1000' }, transfers: [{ sender: 'a', recipient: 'b', amount: '1000' }], activity: [] };
const bill = (id: string, description: string): Command => ({ command_id: id, group_id: group.id, method: 'POST', path: `/groups/${group.id}/expenses`, body: { command_id: id, id, description }, state: 'pending', error: null });
function Probe() {
  const [mode, setMode] = useState<'home' | 'expense' | 'payment'>('home'), [status, setStatus] = useState('Ready'), [saved, setSaved] = useState(0);
  const writes = useRef(Promise.resolve());
  useEffect(() => { void SplashScreen.hideAsync(); }, []);
  async function queueCheck() {
    setStatus('Checking native queue');
    const db = await getDatabase(), previousFetch = globalThis.fetch;
    let start!: () => void, release!: () => void;
    const started = new Promise<void>(done => { start = done; }), waiting = new Promise<void>(done => { release = done; });
    const sent: Record<string, unknown>[] = [];
    globalThis.fetch = async (_url, options) => {
      if (options?.method === 'POST') {
        const body = JSON.parse(String(options.body)); sent.push(body);
        if (body.command_id === 'first') { start(); await waiting; }
        return new Response(JSON.stringify({ id: body.id, version: 5 }), { headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ ...group, version: 5 }), { headers: { 'content-type': 'application/json' } });
    };
    try {
      await db.runAsync('DELETE FROM outbox WHERE owner=?', owner);
      await saveGroup(db, owner, group, 'shared');
      await enqueue(db, owner, bill('first', 'Earlier bill'));
      await enqueueBill(db, owner, bill('second', 'Original lunch'));
      const job = syncOutbox(db, session); await started;
      await enqueueBill(db, owner, { ...bill('edit-second', 'Corrected lunch'), body: { command_id: 'edit-second', id: 'second', description: 'Corrected lunch' } });
      release(); await job;
      if (sent[1]?.description !== 'Corrected lunch' || (await pendingCommands(db, owner)).length) throw Error('Saved edit was lost');
      setStatus('Native queue passed');
    } catch (error) { release(); setStatus(String(error)); }
    finally { globalThis.fetch = previousFetch; }
  }
  return <ScrollView contentContainerStyle={{ padding: 20, gap: 12 }}>
    <Text>Sync regression checks</Text><Text>{status}</Text><Text>Payments saved: {saved}</Text>
    <View style={{ gap: 6 }}>
      <Button title="Run queue checks" onPress={() => void queueCheck()} />
      <Button title="Historical bill" onPress={() => { setStatus('Ready'); setMode('expense'); }} />
      <Button title="Payment check" onPress={() => { setStatus('Ready'); setMode('payment'); }} />
    </View>
    {mode === 'expense' && <ExpenseForm group={{ ...group, focused_expense: expense, participants: [group.participants[0], { ...group.participants[1], removed: true }] }} expense={expense} owner={owner} selfId="a" busy={false} writes={writes}
      onSave={async (value, _attachment, onQueued) => { if (value.paid.b !== '500' || value.shares.b !== '500') throw Error('Historical amounts changed'); onQueued?.(); setStatus('Historical bill saved'); setMode('home'); }} />}
    {mode === 'payment' && <SettleForm group={group} selfId="a" initial={group.transfers[0]} busy={false} returnPayment={null}
      onSave={async (_payment, onQueued) => { setSaved(count => count + 1); onQueued?.(); setStatus('Payment handed off'); throw Error('Synthetic refresh failure after save'); }}
      onCancel={() => setMode('home')} onReviewAttempt={async () => {}} onCancelUPI={async () => {}} onPrepareUPI={async () => { throw Error('No real payments in fixture'); }}
      onArmReturn={async () => { throw Error('No real payments in fixture'); }} onReturnPaymentChange={async () => {}} onResolveReturn={async () => {}} />}
  </ScrollView>;
}
registerRootComponent(() => <SafeAreaProvider initialMetrics={initialWindowMetrics}><UIProvider><LoadingProvider><NavigationContainer><AppFrame><AppStack initialScreen="home" scope="native-edge" blocked={false} render={() => <Probe />} /></AppFrame></NavigationContainer></LoadingProvider></UIProvider></SafeAreaProvider>);
