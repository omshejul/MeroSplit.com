// Synthetic browser QA. Never imported by the production entry point.
import React, { useEffect, useRef, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { Text } from 'react-native-paper';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppFrame, ScreenHeader, pageContentStyle } from '../../src/AppNavigation';
import { UIProvider, useUI } from '../../src/ui';
import { hasOpenDialogs } from '../../src/DialogFocus';
import ExpenseForm from '../../src/ExpenseForm';
import BillPeople from '../../src/BillPeople';
import PersonChoice from '../../src/PersonChoice';
import { TextField, AmountField } from '../../src/FormFields';
import type { Group } from '../../src/types';
const group: Group = { id: 'web-sheet-fixture', name: 'Goa Is On', version: 1, participants: [{ id: 'self', name: 'Om Shejul' }, { id: 'anish', name: 'Anishk' }, { id: 'harshit', name: 'Harshit Dutta' }, { id: 'aryan', name: 'Aryan' }, ...Array.from({ length: 20 }, (_, i) => ({ id: `person-${i}`, name: `Person ${i + 5}` }))], expenses: [], settlements: [], balances: {}, transfers: [], activity: [] };
function Gallery() {
 const { ui } = useUI(), writes = useRef(Promise.resolve()), [busy, setBusy] = useState(false);
 useEffect(() => { Object.assign(window, { setSheetBusy: setBusy, sheetHasDialogs: hasOpenDialogs }); return () => { delete (window as any).setSheetBusy; delete (window as any).sheetHasDialogs; }; }, []);
 return <AppFrame><ScreenHeader title="Add expense" busy={busy} /><ScrollView contentContainerStyle={pageContentStyle} keyboardShouldPersistTaps="handled"><Text style={ui.caption}>{group.name}</Text>{location.search.includes('isolated') ? <SheetControls busy={busy} /> : <ExpenseForm owner="web-sheet-qa-20261101" group={group} selfId="self" busy={busy} writes={writes} onSave={async () => {}} />}</ScrollView></AppFrame>;
}
// Isolate shared UI from WebKit's headless persistent-storage capabilities.
function SheetControls({ busy }: { busy: boolean }) {
 const [selected, setSelected] = useState(['self']), [description, setDescription] = useState(''), [amount, setAmount] = useState('300');
 const people = group.participants.map(person => <View key={person.id}><PersonChoice person={person} title={person.name} selected={selected.includes(person.id)} disabled={busy} onPress={() => setSelected(value => value.includes(person.id) ? value.filter(id => id !== person.id) : [...value, person.id])} />{selected.length > 1 && selected.includes(person.id) && <TextField label={`Paid by ${person.name}`} keyboardType="decimal-pad" editable={!busy} />}</View>);
 return <><AmountField label="Amount (₹)" value={amount} onChangeText={setAmount} /><TextField label="Description" placeholder="What was it for?" value={description} onChangeText={setDescription} /><BillPeople title="Who paid?" icon="pay" summary="Om Shejul (you)" inline={false} disabled={busy} count={selected.length}>{people}</BillPeople><BillPeople title="Split between" icon="people" summary="Everyone equally" inline={false} disabled={busy} count={selected.length}>{people}</BillPeople><TextField label="Notes (optional)" multiline /></>;
}
export default function SheetGallery() { return <SafeAreaProvider><UIProvider><Gallery /></UIProvider></SafeAreaProvider>; }
