import React from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { Text } from 'react-native-paper';
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

const styles = StyleSheet.create({
  field: { gap: 7 },
  amount: { fontSize: 32, fontWeight: '600', minHeight: 64, fontVariant: ['tabular-nums'] },
});
