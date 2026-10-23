import React from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { RadioButton, Text } from 'react-native-paper';
import { useUI } from './ui';

type TextFieldProps = React.ComponentPropsWithRef<typeof TextInput> & { label: string; containerStyle?: StyleProp<ViewStyle> };

export function TextField({ label, style, containerStyle, keyboardType = 'default', ...input }: TextFieldProps) {
  const { palette, ui, inputColors } = useUI();
  return <View style={[styles.field, containerStyle]}>
    <Text style={ui.label}>{label}</Text>
    <TextInput {...inputColors} accessibilityLabel={label} placeholderTextColor={palette.muted}
      keyboardType={keyboardType} {...input} style={[ui.input, style]} />
  </View>;
}

export function AmountField({ style, ...input }: TextFieldProps) {
  return <TextField keyboardType="decimal-pad" {...input} style={[styles.amount, style]} />;
}

export function EmailField(input: TextFieldProps) {
  return <TextField autoCorrect={false} autoCapitalize="none" autoComplete="email" keyboardType="email-address" {...input} />;
}

export function RadioChoice({ label, value, selected, disabled, onPress, accessibilityLabel = label }: {
  label: string; value: string; selected: boolean; disabled?: boolean; onPress: () => void; accessibilityLabel?: string;
}) {
  const { ui } = useUI();
  return <RadioButton.Item label={label} value={value} status={selected ? 'checked' : 'unchecked'} disabled={disabled}
    onPress={onPress} accessibilityLabel={accessibilityLabel} labelStyle={ui.body} mode="android" />;
}

const styles = StyleSheet.create({
  field: { gap: 7 },
  amount: { fontSize: 32, fontWeight: '600', minHeight: 64, fontVariant: ['tabular-nums'] },
});
