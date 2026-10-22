import React, { useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { Button as PaperButton, MD3LightTheme, PaperProvider } from 'react-native-paper';
import DateTimePicker from '@react-native-community/datetimepicker';
import { HugeiconsIcon } from '@hugeicons/react-native';
import Add01Icon from '@hugeicons/core-free-icons/Add01Icon';
import ArrowDown01Icon from '@hugeicons/core-free-icons/ArrowDown01Icon';
import ArrowLeft01Icon from '@hugeicons/core-free-icons/ArrowLeft01Icon';
import ArrowRight01Icon from '@hugeicons/core-free-icons/ArrowRight01Icon';
import CheckmarkCircle01Icon from '@hugeicons/core-free-icons/CheckmarkCircle01Icon';
import Clock01Icon from '@hugeicons/core-free-icons/Clock01Icon';
import Invoice01Icon from '@hugeicons/core-free-icons/Invoice01Icon';
import Settings01Icon from '@hugeicons/core-free-icons/Settings01Icon';
import UserCircleIcon from '@hugeicons/core-free-icons/UserCircleIcon';
import UserGroupIcon from '@hugeicons/core-free-icons/UserGroupIcon';
import UserMultipleIcon from '@hugeicons/core-free-icons/UserMultipleIcon';
import Wallet01Icon from '@hugeicons/core-free-icons/Wallet01Icon';
import Calendar03Icon from '@hugeicons/core-free-icons/Calendar03Icon';

export const colors = { background: '#F5F8F6', surface: '#FFFFFF', text: '#172A23', muted: '#61726A', accent: '#1F6F5C', soft: '#DFF5E9', line: '#DEE8E1', error: '#A93A28' };
const icons = { add: Add01Icon, down: ArrowDown01Icon, back: ArrowLeft01Icon, next: ArrowRight01Icon, check: CheckmarkCircle01Icon, history: Clock01Icon, bill: Invoice01Icon, settings: Settings01Icon, me: UserCircleIcon, groups: UserGroupIcon, people: UserMultipleIcon, pay: Wallet01Icon };
export type IconName = keyof typeof icons;
export function Icon({ name, size = 22, color = colors.accent }: { name: IconName; size?: number; color?: string }) {
  return <HugeiconsIcon icon={icons[name]} size={size} color={color} strokeWidth={1.7} />;
}
export const theme = { ...MD3LightTheme, roundness: 4, colors: { ...MD3LightTheme.colors, primary: colors.accent, onPrimary: colors.surface, primaryContainer: colors.soft, onPrimaryContainer: colors.accent, secondary: colors.accent, onSecondary: colors.surface, secondaryContainer: colors.soft, onSecondaryContainer: colors.accent, background: colors.background, surface: colors.surface, onSurface: colors.text, onSurfaceVariant: colors.muted, outline: colors.line, error: colors.error } };
function LibraryIcon({ name, color, size }: { name: string; color?: string; size: number }) {
  const libraryIcons = { check: CheckmarkCircle01Icon, 'chevron-down': ArrowDown01Icon };
  return <HugeiconsIcon icon={libraryIcons[name as keyof typeof libraryIcons] ?? CheckmarkCircle01Icon} color={color ?? colors.accent} size={size} strokeWidth={1.7} />;
}
export function UIProvider({ children }: { children: React.ReactNode }) {
  return <PaperProvider theme={theme} settings={{ icon: LibraryIcon }}>{children}</PaperProvider>;
}
export function Button({ title, onPress, disabled = false, kind = 'secondary', icon, accessibilityLabel }: { title: string; accessibilityLabel?: string; onPress: () => void; disabled?: boolean; kind?: 'primary' | 'secondary' | 'text' | 'danger'; icon?: IconName }) {
  return <PaperButton accessibilityLabel={accessibilityLabel ?? title} mode={kind === 'text' ? 'text' : kind === 'secondary' ? 'contained-tonal' : 'contained'} onPress={onPress} disabled={disabled}
    icon={icon ? ({ size, color }) => <Icon name={icon} size={size} color={color} /> : undefined}
    buttonColor={kind === 'danger' ? colors.error : undefined} style={{ borderRadius: 16 }} contentStyle={{ minHeight: kind === 'text' ? 44 : 52 }} labelStyle={{ fontSize: 16, fontWeight: '600' }}>{title}</PaperButton>;
}
const dateText = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
export function DateField({ label, value, onChange, disabled = false }: { label: string; value: string; onChange: (value: string) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const parsed = new Date(`${value}T12:00:00`), valid = !Number.isNaN(parsed.getTime()) && dateText(parsed) === value;
  return <View style={{ gap: 8 }}><Text style={ui.label}>{label}</Text>
    <PaperButton mode="outlined" accessibilityLabel={`${label}: ${value || 'Choose date'}`} disabled={disabled} onPress={() => setOpen(true)} icon={({ color, size }) => <HugeiconsIcon icon={Calendar03Icon} color={color} size={size} />} contentStyle={{ minHeight: 52 }} style={{ borderRadius: 14 }}>
      {valid ? parsed.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : 'Choose date'}
    </PaperButton>
    {open && !disabled && <><DateTimePicker disabled={disabled} value={valid ? parsed : new Date()} mode="date" display={Platform.OS === 'ios' ? 'inline' : 'default'} onChange={(event, date) => { if (disabled) return; if (Platform.OS !== 'ios') setOpen(false); if (event.type === 'set' && date) onChange(dateText(date)); }} />
      {Platform.OS === 'ios' && <Button title="Done" kind="text" onPress={() => setOpen(false)} />}</>}
  </View>;
}
export function Avatar({ name }: { name: string }) {
  return <View accessible={false} style={ui.avatar}><Text style={ui.initials}>{name.trim().split(/\s+/).map(word => word[0]).join('').slice(0, 2).toUpperCase()}</Text></View>;
}
export function Disclosure({ title, children, initialOpen = false }: { title: string; children: React.ReactNode; initialOpen?: boolean }) {
  const [open, setOpen] = useState(initialOpen);
  return <View style={ui.disclosure}>
    <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen(value => !value)} style={ui.disclosureHeading}>
      <Text style={ui.section}>{title}</Text><View style={{ transform: [{ rotate: open ? '180deg' : '0deg' }] }}><Icon name="down" size={20} /></View>
    </Pressable>
    {open && <View style={ui.disclosureBody}>{children}</View>}
  </View>;
}
export const ui = StyleSheet.create({
  section: { fontSize: 18, lineHeight: 24, fontWeight: '600', color: colors.text },
  body: { fontSize: 16, lineHeight: 23, color: colors.text },
  caption: { fontSize: 14, lineHeight: 20, color: colors.muted },
  label: { fontSize: 14, lineHeight: 20, fontWeight: '500', color: colors.muted },
  numeric: { fontSize: 32, lineHeight: 40, fontWeight: '600', color: colors.text, fontVariant: ['tabular-nums'] },
  input: { minHeight: 52, paddingHorizontal: 16, paddingVertical: 12, borderRadius: 14, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line, color: colors.text, fontSize: 17 },
  row: { minHeight: 70, paddingVertical: 15, flexDirection: 'row', alignItems: 'center', gap: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  rowBody: { flex: 1, gap: 3 },
  rowTitle: { fontSize: 17, lineHeight: 23, fontWeight: '500', color: colors.text },
  rowSub: { fontSize: 14, lineHeight: 20, color: colors.muted },
  avatar: { width: 44, height: 44, borderRadius: 16, backgroundColor: colors.soft, alignItems: 'center', justifyContent: 'center' },
  initials: { fontSize: 17, fontWeight: '600', color: colors.accent },
  notice: { backgroundColor: colors.surface, borderLeftWidth: 3, borderLeftColor: colors.accent, borderRadius: 12, padding: 14, color: colors.text, fontSize: 14, lineHeight: 21 },
  error: { color: colors.error, fontSize: 15, lineHeight: 22 },
  disclosure: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  disclosureHeading: { minHeight: 60, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  disclosureBody: { gap: 12, paddingBottom: 18 },
});
