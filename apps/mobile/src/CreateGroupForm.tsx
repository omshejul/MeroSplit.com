import React, { useState } from 'react';
import { View } from 'react-native';
import { TextField } from './FormFields';
import { Button } from './ui';

export type NewGroupValues = { name: string; people: string[]; email: string };
export default function CreateGroupForm({ direct, busy, onCreate }: { direct: boolean; busy: boolean; onCreate: (values: NewGroupValues) => void }) {
  const [name, setName] = useState(''), [people, setPeople] = useState(['']), [email, setEmail] = useState('');
  const valid = people.every(value => !!value.trim()) && (direct ? !email.trim() || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) : !!name.trim());
  return <>
    {!direct && <TextField label="Group name" value={name} onChangeText={setName} autoCorrect={false} autoCapitalize="words" />}
    {people.map((person, index) => <View key={index} style={{ gap: 6 }}>
      <TextField label={direct ? 'Their name' : `Person ${index + 1}`} value={person} onChangeText={value => setPeople(rows => rows.map((row, at) => at === index ? value : row))} autoCorrect={false} autoCapitalize="words" />
      {!direct && people.length > 1 && <Button title={`Remove person ${index + 1}`} kind="text" disabled={busy} onPress={() => setPeople(rows => rows.filter((_, at) => at !== index))} />}
    </View>)}
    {!direct && <Button title="Add person" kind="text" icon="add" disabled={busy} onPress={() => setPeople(rows => [...rows, ''])} />}
    {direct && <TextField label="Email (optional)" value={email} onChangeText={setEmail} autoCorrect={false} autoCapitalize="none" autoComplete="email" keyboardType="email-address" />}
    <Button title={direct ? 'Add person' : 'Create group'} kind="primary" disabled={busy || !valid} onPress={() => onCreate({ name, people, email })} />
  </>;
}
