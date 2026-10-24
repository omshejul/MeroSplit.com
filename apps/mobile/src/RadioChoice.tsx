import React from 'react';
import { RadioButton } from 'react-native-paper';
import { useUI } from './ui';

export type RadioChoiceProps = { label: string; value: string; selected: boolean; disabled?: boolean; onPress: () => void; accessibilityLabel?: string; group?: string };

export default function RadioChoice({ label, value, selected, disabled, onPress, accessibilityLabel = label }: RadioChoiceProps) {
  const { ui } = useUI();
  return <RadioButton.Item label={label} value={value} status={selected ? 'checked' : 'unchecked'} disabled={disabled}
    onPress={onPress} accessibilityLabel={accessibilityLabel} labelStyle={ui.body} mode="android" />;
}
