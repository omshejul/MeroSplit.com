import React from 'react';
import { View } from 'react-native';
import { Text } from 'react-native-paper';
import RadioChoice from './RadioChoice';
import { useUI } from './ui';

export default function ChoiceGroup<T extends string>({ label, group, options, selected, disabled, note, onChoose }: {
  label?: string; group: string; options: readonly { value: T; label: string }[]; selected: T; disabled: boolean; note?: string; onChoose: (value: T) => void;
}) {
  const { ui } = useUI();
  return <View role="radiogroup" aria-label={label ?? 'Default currency'} aria-disabled={disabled || undefined}>
    {!!label && <Text style={[ui.label, { paddingHorizontal: 16, paddingTop: 8 }]}>{label}</Text>}
    {!!note && <Text style={[ui.caption, { paddingHorizontal: 16 }]}>{note}</Text>}
    {options.map(option => <RadioChoice key={option.value} group={group} value={option.value} label={option.label} selected={selected === option.value} disabled={disabled} onPress={() => onChoose(option.value)} />)}
  </View>;
}
