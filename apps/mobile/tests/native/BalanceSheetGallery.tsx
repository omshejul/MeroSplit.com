// Synthetic native QA. Never imported by the production entry point.
import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import ScrollView from '../../src/KeyboardScrollView';
import { Text } from 'react-native-paper';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { File, Paths } from 'expo-file-system';
import { UIProvider, Button, useUI } from '../../src/ui';
import { AppFrame, ScreenHeader, pageContentStyle } from '../../src/AppNavigation';
import AppStack, { NavigationContainer, useAppNavigation } from '../../src/AppStack';
import BalanceExplanation, { type BalanceSelection } from '../../src/BalanceExplanationDialog';
import { balanceKey } from '../../src/balanceExplanation';
import { directTransfers, proposeTransfers } from '../../src/accounting';
import { ExpenseDetail } from '../../src/GroupScreen';
import type { Expense, Group } from '../../src/types';
const file = new File(Paths.document, 'balance-sheet-state.json');
const save = (value: unknown) => file.write(JSON.stringify(value));
const entries = [ ['Fbomb', 11900, 20700, 'food'], ['bobby', 53300, 0, 'food'], ['savara', 58333, 58333, 'food'], ['A2 Arambol lunch', 68000, 93000, 'food'], ['Food Planet Arambol', 17000, 11000, 'food'] ] as const;
function fixture(long: boolean, simplified: boolean): Group {
 if (simplified) {
  const make = (id: string, payer: string, shares: Record<string, string>): Expense => ({ id, version: 1, description: id, total: Object.values(shares).reduce((sum, amount) => sum + BigInt(amount), 0n).toString(), paid: { [payer]: Object.values(shares).reduce((sum, amount) => sum + BigInt(amount), 0n).toString() }, shares, split: { mode: 'exact', values: shares }, date: '2026-11-01', category: 'food', notes: '', deleted: false });
  const expenses = [make('Dinner', 'a', { b: '100000' }), make('Taxi', 'b', { c: '60000' })];
  const balances = { a: '100000', b: '-40000', c: '-60000' };
  return { id: 'balance-sheet-qa', name: 'Goa Is On', version: 1, simplify_debts: true, participants: [{ id: 'a', name: 'Me' }, { id: 'b', name: 'Aditya' }, { id: 'c', name: 'Anish' }], expenses, settlements: [], activity: [], balances, transfers: proposeTransfers(balances) };
 }
 const expenses: Expense[] = Array.from({ length: long ? 30 : entries.length }, (_, i) => {
  const [description, effect, share, category] = entries[i % entries.length];
  return { id: String(i), version: 1, description: description + (i > 4 ? ` ${i + 1}` : ''), total: String(effect + share), paid: { a: String(effect + share) }, shares: { a: String(share), b: String(effect) }, split: { mode: 'exact', values: { a: String(share), b: String(effect) } }, date: '2026-11-01', category, notes: '', deleted: false };
 });
 const net = expenses.reduce((sum, bill) => sum + BigInt(bill.shares.b), 0n);
 const balances = { a: String(net), b: String(-net) };
 return { id: 'balance-sheet-qa', name: 'Goa Is On', version: 1, simplify_debts: simplified, participants: [{ id: 'a', name: 'Me' }, { id: 'b', name: 'Anish' }], expenses, settlements: [], activity: [], balances, transfers: simplified ? proposeTransfers(balances) : directTransfers(expenses, []) };
}
function Gallery() {
 const navigation = useAppNavigation(), { ui, changeAppearance, changeColorFamily } = useUI();
 const [selection, setSelection] = useState<BalanceSelection | null>(null), [stale, setStale] = useState(false), [closes, setCloses] = useState(0), [opened, setOpened] = useState<{ bill: Expense; group: Group } | null>(null);
 useEffect(() => { save({ ready: true, open: !!selection, closes, stale }); }, [selection, closes, stale]);
 function open(long = false, failed = false, simplified = false, outgoing = false) {
  const group = fixture(long, simplified); setStale(false);
  setSelection({ group, accepted: group, selfId: outgoing ? group.transfers[0].sender : 'a', commands: [], transfer: group.transfers[0], restoreFocus: () => {}, load: failed ? async () => { throw new Error('Connect to load the full breakdown.'); } : async () => ({ group, saved: true }) });
 }
 return <NavigationContainer ref={navigation.ref}><AppFrame><AppStack initialScreen="home" scope="balance-sheet-qa" blocked={false} render={() => <>
  <ScreenHeader title={opened ? opened.bill.description : "Balance sheet QA"} busy={false} />
  <ScrollView contentContainerStyle={pageContentStyle}>{opened ? <><Button title="Back to balances" onPress={() => setOpened(null)} /><ExpenseDetail expense={opened.bill} group={opened.group} selfId="a" busy={false} canEdit={false} onEdit={() => {}} onReverse={() => {}} /></> : <><View style={{ flexDirection: 'row', gap: 12 }}><Button title="Use light" onPress={() => { void changeColorFamily('orchid'); void changeAppearance('light'); }} /><Button title="Use dark" onPress={() => { void changeColorFamily('orchid'); void changeAppearance('dark'); }} /></View><Button title="Open simplified breakdown" onPress={() => open(false, false, true)} /><Button title="Open simplified outgoing" onPress={() => open(false, false, true, true)} /><Button title="Open amount breakdown" onPress={() => open()} /><Button title="Open outgoing breakdown" onPress={() => open(false, false, false, true)} /><Button title="Open long breakdown" onPress={() => open(true)} /><Button title="Open offline error" onPress={() => open(false, true)} /><Text style={ui.caption}>Closed {closes} times</Text></>}</ScrollView>
  <BalanceExplanation onOpenBill={bill => { if (selection) setOpened({ bill, group: selection.group }); }} selection={selection} currentKey={selection ? stale ? 'changed' : balanceKey(selection.group, []) : ''} onClose={() => { setSelection(null); setCloses(value => value + 1); }} />
 </>} /></AppFrame></NavigationContainer>;
}
export default function BalanceSheetGallery() { return <SafeAreaProvider><UIProvider><Gallery /></UIProvider></SafeAreaProvider>; }
