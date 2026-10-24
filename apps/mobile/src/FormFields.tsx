import React, { useId } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { Text } from 'react-native-paper';
export { default as RadioChoice } from './RadioChoice';
import FieldLabel from './FieldLabel';
import { useUI } from './ui';

type TextFieldProps = React.ComponentPropsWithRef<typeof TextInput> & { label: string; containerStyle?: StyleProp<ViewStyle> };

export function TextField({ label, style, containerStyle, keyboardType = 'default', ...input }: TextFieldProps) {
  const { palette, ui, inputColors } = useUI();
  const id = useId(), nativeID = input.nativeID ?? id;
  return <View style={[styles.field, containerStyle]}>
    <FieldLabel nativeID={nativeID} style={ui.label}>{label}</FieldLabel>
    <TextInput {...inputColors} accessibilityLabel={label} placeholderTextColor={palette.muted}
      keyboardType={keyboardType} {...input} nativeID={nativeID} style={[ui.input, style]} />
  </View>;
}

export function AmountField({ style, ...input }: TextFieldProps) {
  return <TextField keyboardType="decimal-pad" {...input} style={[styles.amount, style]} />;
}

export function EmailField(input: TextFieldProps) {
  return <TextField autoCorrect={false} autoCapitalize="none" autoComplete="email" keyboardType="email-address" {...input} />;
}

const styles = StyleSheet.create({
  field: { gap: 7 },
  amount: { fontSize: 32, fontWeight: '600', minHeight: 64, fontVariant: ['tabular-nums'] },
});
