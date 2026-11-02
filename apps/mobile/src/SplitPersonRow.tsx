import React from 'react';
import { StyleSheet, View, useWindowDimensions } from 'react-native';
import { Text } from 'react-native-paper';
import type { Participant } from './types';
import type { Split } from './accounting';
import { currencySymbol } from './currency';
import { Avatar, Button, Icon, useUI } from './ui';
import { TextField } from './FormFields';

// Shares support four decimal places. Step in integers without rounding the fraction.
export function stepShare(value: string, direction: -1 | 1): string | null {
  if (value.length > 40 || !/^(0|[1-9]\d*)(\.\d{0,4})?$/.test(value || '0')) return null;
  const [whole, fraction = ''] = (value || '0').split('.');
  const scaled = BigInt(whole) * 10000n + BigInt(fraction.padEnd(4, '0')) + BigInt(direction) * 10000n;
  if (scaled <= 0n) return '0';
  const tail = (scaled % 10000n).toString().padStart(4, '0').replace(/0+$/, '');
  const result = `${scaled / 10000n}${tail ? `.${tail}` : ''}`;
  return result.length <= 40 ? result : null;
}

export default function SplitPersonRow({ person, title, selected, disabled, editable, amount, mode, value, onToggle, onChange }: {
  person: Participant; title: string; selected: boolean; disabled: boolean; editable: boolean;
  amount?: string; mode: Exclude<Split['mode'], 'equal'>; value: string;
  onToggle: () => void; onChange: (value: string) => void;
}) {
  const { ui, palette, dark } = useUI(), { fontScale = 1 } = useWindowDimensions();
  const shares = mode === 'shares', adjustment = mode === 'adjustment', negative = value.startsWith('-'), canEdit = selected && editable;
  const minus = shares ? stepShare(value, -1) : null, plus = shares ? stepShare(value, 1) : null;
  const atZero = /^0(?:\.0*)?$/.test(value || '0');
  const controlWidth = (shares ? 90 + Math.max(44, Math.min(112, value.length * 10 + 8)) : adjustment ? 120 : 96) * Math.min(fontScale, 1.5);
  const name = `${adjustment ? 'Adjustment for ' : ''}${title} ${mode === 'exact' || adjustment ? `(${currencySymbol()})` : mode === 'percent' ? '(%)' : '(shares)'}`;
  return <View style={[styles.row, { borderBottomColor: palette.line }]}>
    <Button kind="plain" accessibilityRole="checkbox" accessibilityLabel={`${title}${amount ? `, ${amount}` : ''}`}
      accessibilityState={{ checked: selected, disabled }} disabled={disabled} onPress={onToggle}
      style={[styles.person, { opacity: disabled ? 0.5 : 1 }]}>
      <View accessible={false} aria-hidden style={[styles.check, { borderColor: selected ? palette.accent : palette.outline, backgroundColor: selected ? palette.accent : 'transparent' }]}>
        {selected && <Icon name="tick" size={16} color={dark ? '#161616' : '#FFFFFF'} />}
      </View>
      <Avatar name={person.name} photo={person.profile_photo} size={30} />
      <View style={{ flex: 1 }}><Text style={[ui.body, styles.name]}>{title}</Text>
        {!!amount && mode !== 'exact' && <Text style={[ui.caption, styles.preview]}>{amount}</Text>}
      </View>
    </Button>
    <View style={[styles.control, { width: controlWidth, borderColor: palette.outline, paddingHorizontal: shares ? 0 : 6, opacity: canEdit ? 1 : 0.5 }]}>
      {shares && <Button kind="plain" accessibilityLabel={`Decrease shares for ${title}`} disabled={!canEdit || minus === null || atZero}
        onPress={() => { if (canEdit && minus !== null) onChange(minus); }} style={styles.step}>
        <Icon name="subtract" size={18} color={!canEdit || minus === null || atZero ? palette.muted : palette.accent} />
      </Button>}
      {adjustment && <Button kind="plain" accessibilityLabel={`${negative ? 'Switch to add' : 'Switch to subtract'} for ${title}`} disabled={!canEdit} onPress={() => { if (canEdit) onChange(negative ? value.slice(1) : `-${value || '0'}`); }} style={styles.step}><Icon name={negative ? 'subtract' : 'add'} size={18} /></Button>}
      {mode === 'exact' && <Text accessible={false} style={ui.caption}>{currencySymbol()}</Text>}
      <TextField hideLabel label={name} autoCorrect={false} keyboardType="decimal-pad" value={adjustment && negative ? value.slice(1) : value} editable={canEdit}
        onChangeText={text => onChange(adjustment && negative && text && !text.startsWith('-') ? `-${text}` : text)} containerStyle={styles.inputContainer}
        style={[styles.input, { textAlign: shares ? 'center' : 'right' }]} />
      {mode === 'percent' && <Text accessible={false} style={ui.caption}>%</Text>}
      {shares && <Button kind="plain" accessibilityLabel={`Increase shares for ${title}`} disabled={!canEdit || plus === null}
        onPress={() => { if (canEdit && plus !== null) onChange(plus); }} style={styles.step}>
        <Icon name="add" size={18} color={!canEdit || plus === null ? palette.muted : palette.accent} />
      </Button>}
    </View>
  </View>;
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 8, minHeight: 64, paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth },
  person: { flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1, minWidth: 136, minHeight: 44 },
  check: { width: 22, height: 22, borderWidth: 1.5, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  name: { fontSize: 15, lineHeight: 20 }, preview: { fontSize: 12, lineHeight: 17, fontVariant: ['tabular-nums'] },
  control: { flexDirection: 'row', alignItems: 'center', minHeight: 46, borderWidth: 1, borderRadius: 9, marginLeft: 'auto', paddingHorizontal: 0 },
  step: { width: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  inputContainer: { flex: 1, minWidth: 0 },
  input: { minHeight: 44, paddingHorizontal: 4, paddingVertical: 8, borderWidth: 0, backgroundColor: 'transparent', fontSize: 17, fontVariant: ['tabular-nums'] },
});
