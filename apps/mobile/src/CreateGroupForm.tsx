import { PersonDetailsFields } from './FormFields';
import Form from './Form';
import React, { useState } from 'react';
import { Switch, View } from 'react-native';
import { Text } from 'react-native-paper';
import { EmailField, TextField } from './FormFields';
import { Button, useUI } from './ui';

export type NewGroupValues = { name: string; people: string[]; email: string; emails?: string[]; simplify_debts?: boolean };
export default function CreateGroupForm({ direct, busy, onCreate }: { direct: boolean; busy: boolean; onCreate: (values: NewGroupValues) => void }) {
  const { ui } = useUI();
  const [name, setName] = useState(''), [people, setPeople] = useState<string[]>(direct ? [''] : []), [emails, setEmails] = useState<string[]>(direct ? [''] : []), [email, setEmail] = useState('');
  const [simplify, setSimplify] = useState(true);
  const validEmail = (value: string) => !value.trim() || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
  const valid = people.every(value => !!value.trim()) && (direct ? validEmail(email) : !!name.trim() && emails.every(validEmail));
  const submit = () => { if (!busy && valid) onCreate({ name, people, email, emails, simplify_debts: direct || simplify }); };
  return <Form label={direct ? 'Add person' : 'New group'} onSubmit={submit}>
    {!direct && <><TextField label="Group name" value={name} onChangeText={setName} editable={!busy} autoCorrect={false} autoCapitalize="words" /><Text style={ui.caption}>Start with just you, then share a link. Adding people now is optional.</Text></>}
    {people.map((person, index) => <View key={index} style={{ gap: 6 }}>
      {direct ? <TextField label="Their name" value={person} onChangeText={value => setPeople(rows => rows.map((row, at) => at === index ? value : row))} editable={!busy} autoCorrect={false} autoCapitalize="words" /> : <>
        <PersonDetailsFields name={{ label: `Person ${index + 1}`, value: person, onChangeText: value => setPeople(rows => rows.map((row, at) => at === index ? value : row)), editable: !busy }} email={{ label: `Person ${index + 1} email (optional)`, value: emails[index] ?? '', onChangeText: value => setEmails(rows => rows.map((row, at) => at === index ? value : row)), editable: !busy }} />
        <Button title={`Remove person ${index + 1}`} kind="text" disabled={busy} onPress={() => { setPeople(rows => rows.filter((_, at) => at !== index)); setEmails(rows => rows.filter((_, at) => at !== index)); }} />
      </>}
    </View>)}
    {!direct && <><Button title={people.length ? 'Add another person' : 'Add person (optional)'} kind="text" icon="add" disabled={busy} onPress={() => { setPeople(rows => [...rows, '']); setEmails(rows => [...rows, '']); }} />{!!people.length && <Text style={ui.caption}>Existing accounts are added to the group. For other emails, send an invite from group settings.</Text>}</>}
    {!direct && <View style={{ gap: 6 }}><View style={ui.row}><Text style={[ui.rowTitle, { flex: 1 }]}>Simplify debts</Text><Switch accessibilityLabel="Simplify debts" value={simplify} disabled={busy} onValueChange={setSimplify} /></View><Text style={ui.caption}>{simplify ? "Reduces payments using everyone's net balance." : 'Each person repays the member who paid for them.'}</Text></View>}
    {direct && <EmailField label="Email (optional)" value={email} onChangeText={setEmail} editable={!busy} />}
    <Button title={busy ? direct ? 'Adding…' : 'Creating…' : direct ? 'Add person' : 'Create group'} kind="primary" disabled={busy || !valid} onPress={submit} style={!direct ? { minHeight: 48 } : undefined} />
    {!direct && <Text style={ui.caption}>You will be the organizer.</Text>}
  </Form>;
}
