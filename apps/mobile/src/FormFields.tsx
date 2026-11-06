import TextInput from './KeyboardInput';
import React, { useId } from 'react';
import { StyleSheet, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';

export { default as RadioChoice } from './RadioChoice';
import FieldLabel from './FieldLabel';
import { useUI } from './ui';

export type TextFieldProps = React.ComponentPropsWithRef<typeof TextInput> & { label: string; containerStyle?: StyleProp<ViewStyle>; right?: React.ReactNode; hideLabel?: boolean };

export function TextField({ label, style, containerStyle, right, hideLabel = false, keyboardType = 'default', ...input }: TextFieldProps) {
  const { palette, ui, inputColors } = useUI();
  const id = useId(), nativeID = input.nativeID ?? id;
  // Null keeps the same input mounted when an accessory disappears.
  const hasRight = right !== undefined;
  const field = <TextInput {...inputColors} accessibilityLabel={label} placeholderTextColor={palette.muted}
    keyboardType={keyboardType} {...input} nativeID={nativeID} style={[ui.input, hasRight && styles.inputWithRight, style]} />;
  return <View style={[styles.field, containerStyle]}>
    {!hideLabel && <FieldLabel nativeID={nativeID} style={ui.label}>{label}</FieldLabel>}
    {hasRight ? <View style={[styles.inputRow, { borderColor: ui.input.borderColor, borderRadius: ui.input.borderRadius, backgroundColor: ui.input.backgroundColor }]}>{field}{right}</View> : field}
  </View>;
}

export function AmountField({ style, ...input }: TextFieldProps) {
  return <TextField keyboardType="decimal-pad" {...input} style={[styles.amount, style]} />;
}

export function EmailField(input: TextFieldProps) {
  return <TextField autoCorrect={false} autoCapitalize="none" autoComplete="email" keyboardType="email-address" {...input} />;
}

export function UPIAddressField(input: TextFieldProps) {
  return <TextField autoCorrect={false} autoCapitalize="none" autoComplete="off" keyboardType="email-address" maxLength={254} {...input} />;
}
export function PersonDetailsFields({ name, email }: { name: TextFieldProps; email: TextFieldProps }) {
  return <><TextField autoCorrect={false} autoCapitalize="words" {...name} /><EmailField {...email} /></>;
}

const styles = StyleSheet.create({
  field: { gap: 7 },
  inputRow: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, paddingRight: 8 },
  inputWithRight: { flex: 1, minWidth: 0, minHeight: 46, borderWidth: 0, backgroundColor: 'transparent' },
  amount: { fontVariant: ['tabular-nums'] },
});
