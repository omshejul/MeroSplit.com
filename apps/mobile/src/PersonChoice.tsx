import RadioChoice from './RadioChoice';
import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Text } from 'react-native-paper';
import type { Participant } from './types';
import PersonRow from './PersonRow';
import { Icon, useUI } from './ui';

export default function PersonChoice({ person, title, selected, disabled = false, amount, onPress, accessibilityLabel, role = 'checkbox' }: {
  person: Pick<Participant, 'name' | 'profile_photo'> & { id?: string }; title: string; selected: boolean; disabled?: boolean; amount?: string; onPress: () => void; role?: 'checkbox' | 'radio'; accessibilityLabel?: string;
}) {
  const { ui, palette, dark } = useUI();
  if (role === 'radio') return <RadioChoice value={person.id ?? title} label={title} accessibilityLabel={accessibilityLabel ?? title} selected={selected} disabled={disabled} onPress={onPress} />;
  return <PersonRow name={person.name} photo={person.profile_photo} title={title} titleStyle={ui.body} accessibilityRole={role}
    accessibilityLabel={accessibilityLabel ?? `${title}${amount ? `, ${amount}` : ''}`} accessibilityState={{ checked: selected, disabled }} disabled={disabled} onPress={onPress}
    style={{ gap: 12, minHeight: 64, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: palette.line }}
    trailing={<>{!!amount && <Text style={[ui.caption, { flexShrink: 1, textAlign: 'right', fontVariant: ['tabular-nums'] }]}>{amount}</Text>}
      <View accessible={false} aria-hidden style={{ width: 24, height: 24, borderRadius: 12, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center', flexShrink: 0, borderColor: selected ? palette.accent : palette.outline, backgroundColor: selected ? palette.accent : 'transparent' }}>
        {selected && <Icon name="tick" size={18} color={dark ? '#161616' : '#FFFFFF'} />}
      </View></>} />;
}
export function PersonSelectionList({ people, selected, label = person => person.name, disabled = false, onSelect }: {
  people: Pick<Participant, 'id' | 'name' | 'profile_photo'>[]; selected?: string; label?: (person: Pick<Participant, 'id' | 'name' | 'profile_photo'>) => string;
  disabled?: boolean; onSelect: (id: string) => void;
}) {
  return <>{people.map(person => <PersonChoice key={person.id} person={person} title={label(person)} selected={selected === person.id} role="radio" disabled={disabled} onPress={() => onSelect(person.id)} />)}</>;
}
