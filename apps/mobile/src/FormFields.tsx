import React, { useId } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { Text } from 'react-native-paper';
export { default as RadioChoice } from './RadioChoice';
import FieldLabel from './FieldLabel';
import { useUI } from './ui';

type TextFieldProps = React.ComponentPropsWithRef<typeof TextInput> & { label: string; containerStyle?: StyleProp<ViewStyle>; right?: React.ReactNode };

export function TextField({ label, style, containerStyle, right, keyboardType = 'default', ...input }: TextFieldProps) {
  const { palette, ui, inputColors } = useUI();
  const id = useId(), nativeID = input.nativeID ?? id;
  // Null keeps the same input mounted when an accessory disappears.
  const hasRight = right !== undefined;
  const field = <TextInput {...inputColors} accessibilityLabel={label} placeholderTextColor={palette.muted}
    keyboardType={keyboardType} {...input} nativeID={nativeID} style={[ui.input, hasRight && styles.inputWithRight, style]} />;
  return <View style={[styles.field, containerStyle]}>
    <FieldLabel nativeID={nativeID} style={ui.label}>{label}</FieldLabel>
    {hasRight ? <View style={[styles.inputRow, { borderColor: ui.input.borderColor, borderRadius: ui.input.borderRadius, backgroundColor: ui.input.backgroundColor }]}>{field}{right}</View> : field}
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
  inputRow: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, paddingRight: 8 },
  inputWithRight: { flex: 1, minWidth: 0, minHeight: 46, borderWidth: 0, backgroundColor: 'transparent' },
  amount: { fontSize: 32, fontWeight: '600', minHeight: 64, fontVariant: ['tabular-nums'] },
});
