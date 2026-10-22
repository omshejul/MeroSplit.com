import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Appearance, Platform, Pressable, StyleSheet, useColorScheme, View } from 'react-native';
import { Button as PaperButton, MD3DarkTheme, MD3LightTheme, PaperProvider, Text, useTheme } from 'react-native-paper';
import type { MD3Theme } from 'react-native-paper';
import { savedAppearance, saveAppearance } from './native';
import type { AppearancePreference } from './native';
export type { AppearancePreference } from './native';
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

export type Palette = { background: string; surface: string; text: string; muted: string; accent: string; soft: string; line: string; outline: string; error: string };
const colors: Palette = { background: '#F7F7F7', surface: '#FFFFFF', text: '#161616', muted: '#626262', accent: '#161616', soft: '#ECECEC', line: '#D4D4D4', outline: '#8A8A8A', error: '#333333' };
const darkColors: Palette = { background: '#111111', surface: '#1C1C1C', text: '#F5F5F5', muted: '#B5B5B5', accent: '#F5F5F5', soft: '#2D2D2D', line: '#444444', outline: '#808080', error: '#E0E0E0' };
const makeInputColors = (palette: Palette) => ({ selectionColor: Platform.OS === 'ios' ? palette.accent : palette.line, cursorColor: palette.accent, selectionHandleColor: palette.accent });
const inputColors = makeInputColors(colors);
const icons = { add: Add01Icon, down: ArrowDown01Icon, back: ArrowLeft01Icon, next: ArrowRight01Icon, check: CheckmarkCircle01Icon, history: Clock01Icon, bill: Invoice01Icon, settings: Settings01Icon, me: UserCircleIcon, groups: UserGroupIcon, people: UserMultipleIcon, pay: Wallet01Icon };
export type IconName = keyof typeof icons;
export function Icon({ name, size = 22, color }: { name: IconName; size?: number; color?: string }) {
  const { palette } = useUI();
  return <HugeiconsIcon icon={icons[name]} size={size} color={color ?? palette.accent} strokeWidth={1.7} />;
}
function makeTheme(palette: Palette, dark: boolean): MD3Theme {
  const colors = palette, onAccent = dark ? '#161616' : '#FFFFFF';
  return { ...(dark ? MD3DarkTheme : MD3LightTheme), roundness: 2, colors: {
    primary: colors.accent, onPrimary: onAccent, primaryContainer: colors.soft, onPrimaryContainer: colors.text,
    secondary: colors.accent, onSecondary: onAccent, secondaryContainer: colors.soft, onSecondaryContainer: colors.text,
    tertiary: colors.accent, onTertiary: onAccent, tertiaryContainer: colors.soft, onTertiaryContainer: colors.text,
    background: colors.background, onBackground: colors.text, surface: colors.surface, onSurface: colors.text,
    surfaceVariant: colors.soft, onSurfaceVariant: colors.muted,
    surfaceDisabled: dark ? 'rgba(255, 255, 255, 0.12)' : 'rgba(0, 0, 0, 0.12)', onSurfaceDisabled: dark ? 'rgba(255, 255, 255, 0.38)' : 'rgba(0, 0, 0, 0.38)',
    outline: colors.outline, outlineVariant: colors.line, error: colors.error, onError: onAccent, errorContainer: colors.soft, onErrorContainer: colors.error,
    inverseSurface: dark ? '#EAEAEA' : '#303030', inverseOnSurface: dark ? '#161616' : '#FAFAFA', inversePrimary: dark ? '#161616' : '#FFFFFF',
    shadow: '#000000', scrim: '#000000', backdrop: 'rgba(0, 0, 0, 0.4)',
    elevation: dark ? { level0: 'transparent', level1: '#202020', level2: '#242424', level3: '#282828', level4: '#2C2C2C', level5: '#303030' }
      : { level0: 'transparent', level1: '#FAFAFA', level2: '#F7F7F7', level3: '#F2F2F2', level4: '#EEEEEE', level5: '#EAEAEA' },
  } };
}
const theme = makeTheme(colors, false);
const darkTheme = makeTheme(darkColors, true);
type UITheme = MD3Theme & { palette: Palette; ui: ReturnType<typeof makeUI>; inputColors: ReturnType<typeof makeInputColors>; appearance: AppearancePreference; changeAppearance: (value: AppearancePreference) => Promise<void> };
export function useUI() {
  const { palette, ui, inputColors, dark, appearance, changeAppearance } = useTheme<UITheme>();
  return { palette, ui, inputColors, dark, appearance, changeAppearance };
}
function LibraryIcon({ name, color, size }: { name: string; color?: string; size: number }) {
  const { palette } = useUI();
  const libraryIcons = { check: CheckmarkCircle01Icon, 'chevron-down': ArrowDown01Icon };
  return <HugeiconsIcon icon={libraryIcons[name as keyof typeof libraryIcons] ?? CheckmarkCircle01Icon} color={color ?? palette.accent} size={size} strokeWidth={1.7} />;
}
export function UIProvider({ children }: { children: React.ReactNode }) {
  const system = useColorScheme();
  const [appearance, setAppearance] = useState<AppearancePreference>('system');
  const revision = useRef(0), writes = useRef(Promise.resolve());
  useEffect(() => {
    let mounted = true;
    const initialRevision = revision.current;
    void savedAppearance().then(value => {
      if (!mounted || revision.current !== initialRevision) return;
      setAppearance(value);
      Appearance.setColorScheme(value === 'system' ? 'auto' : value);
    }).catch(() => {});
    return () => { mounted = false; };
  }, []);
  const changeAppearance = useCallback(async (value: AppearancePreference) => {
    const currentRevision = ++revision.current;
    const write = writes.current.catch(() => {}).then(() => saveAppearance(value));
    writes.current = write;
    await write;
    if (revision.current !== currentRevision) return;
    setAppearance(value);
    Appearance.setColorScheme(value === 'system' ? 'auto' : value);
  }, []);
  const dark = appearance === 'system' ? system === 'dark' : appearance === 'dark';
  const value = useMemo<UITheme>(() => ({ ...(dark ? darkTheme : theme), palette: dark ? darkColors : colors,
    ui: dark ? darkUI : ui, inputColors: dark ? darkInputColors : inputColors, appearance, changeAppearance,
  }), [dark, appearance, changeAppearance]);
  return <PaperProvider theme={value} settings={{ icon: LibraryIcon }}>{children}</PaperProvider>;
}
export function Button({ title, onPress, disabled = false, kind = 'secondary', icon, accessibilityLabel }: { title: string; accessibilityLabel?: string; onPress: () => void; disabled?: boolean; kind?: 'primary' | 'secondary' | 'text' | 'danger'; icon?: IconName }) {
  const { palette: colors } = useUI();
  return <PaperButton accessibilityLabel={accessibilityLabel ?? title} mode={kind === 'text' ? 'text' : kind === 'secondary' ? 'contained-tonal' : 'contained'} onPress={onPress} disabled={disabled}
    icon={icon ? ({ size, color }) => <Icon name={icon} size={size} color={color} /> : undefined}
    buttonColor={kind === 'danger' ? colors.error : undefined} style={{ borderRadius: 8 }} contentStyle={{ minHeight: Platform.OS === 'ios' ? 44 : 48 }} labelStyle={{ fontSize: 16, fontWeight: '600' }}>{title}</PaperButton>;
}
const dateText = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
export function DateField({ label, value, onChange, disabled = false }: { label: string; value: string; onChange: (value: string) => void; disabled?: boolean }) {
  const { palette: colors, ui, dark } = useUI();
  const [open, setOpen] = useState(false);
  const parsed = new Date(`${value}T12:00:00`), valid = !Number.isNaN(parsed.getTime()) && dateText(parsed) === value;
  return <View style={{ gap: 8 }}><Text style={ui.label}>{label}</Text>
    <PaperButton mode="outlined" accessibilityLabel={`${label}: ${value || 'Choose date'}`} disabled={disabled} onPress={() => setOpen(true)} icon={({ color, size }) => <HugeiconsIcon icon={Calendar03Icon} color={color} size={size} />} contentStyle={{ minHeight: Platform.OS === 'ios' ? 44 : 48 }} style={{ borderRadius: 8 }}>
      {valid ? parsed.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : 'Choose date'}
    </PaperButton>
    {open && !disabled && <><DateTimePicker disabled={disabled} value={valid ? parsed : new Date()} mode="date" accentColor={colors.accent} themeVariant={dark ? 'dark' : 'light'} display={Platform.OS === 'ios' ? 'inline' : 'default'} onChange={(event, date) => { if (disabled) return; if (Platform.OS !== 'ios') setOpen(false); if (event.type === 'set' && date) onChange(dateText(date)); }} />
      {Platform.OS === 'ios' && <Button title="Done" kind="text" onPress={() => setOpen(false)} />}</>}
  </View>;
}
export function Avatar({ name }: { name: string }) {
  const { ui } = useUI();
  return <View accessible={false} style={ui.avatar}><Text style={ui.initials}>{name.trim().split(/\s+/).map(word => word[0]).join('').slice(0, 2).toUpperCase()}</Text></View>;
}
export function Disclosure({ title, children, initialOpen = false }: { title: string; children: React.ReactNode; initialOpen?: boolean }) {
  const { ui } = useUI();
  const [open, setOpen] = useState(initialOpen);
  return <View style={ui.disclosure}>
    <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen(value => !value)} style={ui.disclosureHeading}>
      <Text style={ui.section}>{title}</Text><View style={{ transform: [{ rotate: open ? '180deg' : '0deg' }] }}><Icon name="down" size={20} /></View>
    </Pressable>
    {open && <View style={ui.disclosureBody}>{children}</View>}
  </View>;
}
const makeUI = (colors: Palette) => StyleSheet.create({
  section: { fontSize: 18, lineHeight: 24, fontWeight: '600', color: colors.text },
  body: { fontSize: 16, lineHeight: 23, color: colors.text },
  caption: { fontSize: 14, lineHeight: 20, color: colors.muted },
  label: { fontSize: 14, lineHeight: 20, fontWeight: '500', color: colors.muted },
  numeric: { fontSize: 32, lineHeight: 40, fontWeight: '600', color: colors.text, fontVariant: ['tabular-nums'] },
  input: { minHeight: 48, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 8, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.outline, color: colors.text, fontSize: 17 },
  row: { minHeight: 56, paddingVertical: 10, flexDirection: 'row', alignItems: 'center', gap: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  rowBody: { flex: 1, gap: 3 },
  rowTitle: { fontSize: 17, lineHeight: 23, fontWeight: '500', color: colors.text },
  rowSub: { fontSize: 14, lineHeight: 20, color: colors.muted },
  avatar: { width: 36, height: 36, borderRadius: 8, backgroundColor: colors.soft, alignItems: 'center', justifyContent: 'center' },
  initials: { fontSize: 17, fontWeight: '600', color: colors.accent },
  notice: { backgroundColor: colors.surface, borderLeftWidth: 3, borderLeftColor: colors.accent, borderRadius: 8, padding: 12, color: colors.text, fontSize: 14, lineHeight: 21 },
  error: { color: colors.error, fontSize: 15, lineHeight: 22 },
  disclosure: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  disclosureHeading: { minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  disclosureBody: { gap: 10, paddingBottom: 12 },
});

const ui = makeUI(colors);
const darkUI = makeUI(darkColors), darkInputColors = makeInputColors(darkColors);
