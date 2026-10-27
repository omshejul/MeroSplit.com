import React, { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { Animated, Appearance, Platform, Pressable, StyleSheet, useColorScheme, View } from 'react-native';
import { Button as PaperButton, IconButton as PaperIconButton, List, Tooltip, MD3DarkTheme, MD3LightTheme, PaperProvider, ThemeProvider, Text, useTheme, configureFonts } from 'react-native-paper';
import type { MD3Theme } from 'react-native-paper';
import { savedAppearance, saveAppearance, savedColorFamily, saveColorFamily } from './native';
import type { AppearancePreference } from './native';
export type { AppearancePreference } from './native';
import { isDarkOnly, lookColors, type ColorFamily, type Palette, type ThemeColors } from './theme';
export type { ColorFamily, Palette } from './theme';
import { useSavedChoice } from './savedChoice';
import { initialBrowserAppearance, initialBrowserColorFamily, syncBrowserTheme } from './browserTheme';
import { useFonts } from 'expo-font';
import { appFontFamily, appFontFaces } from './typography';
import FieldLabel from './FieldLabel';
import { useWebInteractions } from './useWebInteractions';
import DateTimePicker from '@react-native-community/datetimepicker';
import { HugeiconsIcon } from '@hugeicons/react-native';
import Attachment01Icon from '@hugeicons/core-free-icons/Attachment01Icon';
import Archive01Icon from '@hugeicons/core-free-icons/Archive01Icon';
import Add01Icon from '@hugeicons/core-free-icons/Add01Icon';
import ArrowDown01Icon from '@hugeicons/core-free-icons/ArrowDown01Icon';
import ArrowLeft01Icon from '@hugeicons/core-free-icons/ArrowLeft01Icon';
import ArrowRight01Icon from '@hugeicons/core-free-icons/ArrowRight01Icon';
import ArrowUpRight01Icon from '@hugeicons/core-free-icons/ArrowUpRight01Icon';
import CheckmarkCircle01Icon from '@hugeicons/core-free-icons/CheckmarkCircle01Icon';
import Clock01Icon from '@hugeicons/core-free-icons/Clock01Icon';
import Invoice01Icon from '@hugeicons/core-free-icons/Invoice01Icon';
import Settings01Icon from '@hugeicons/core-free-icons/Settings01Icon';
import Search01Icon from '@hugeicons/core-free-icons/Search01Icon';
import UserCircleIcon from '@hugeicons/core-free-icons/UserCircleIcon';
import UserGroupIcon from '@hugeicons/core-free-icons/UserGroupIcon';
import UserMultipleIcon from '@hugeicons/core-free-icons/UserMultipleIcon';
import Wallet01Icon from '@hugeicons/core-free-icons/Wallet01Icon';
import MoneyExchange03Icon from '@hugeicons/core-free-icons/MoneyExchange03Icon';
import Calendar03Icon from '@hugeicons/core-free-icons/Calendar03Icon';
import WifiDisconnected01Icon from '@hugeicons/core-free-icons/WifiDisconnected01Icon';
import Refresh01Icon from '@hugeicons/core-free-icons/Refresh01Icon';
import Delete02Icon from '@hugeicons/core-free-icons/Delete02Icon';
import Download01Icon from '@hugeicons/core-free-icons/Download01Icon';
import Upload01Icon from '@hugeicons/core-free-icons/Upload01Icon';
import PencilEdit02Icon from '@hugeicons/core-free-icons/PencilEdit02Icon';
import UserAdd01Icon from '@hugeicons/core-free-icons/UserAdd01Icon';
import Shield01Icon from '@hugeicons/core-free-icons/Shield01Icon';
import HelpCircleIcon from '@hugeicons/core-free-icons/HelpCircleIcon';
import Comment01Icon from '@hugeicons/core-free-icons/Comment01Icon';
import ThumbsUpIcon from '@hugeicons/core-free-icons/ThumbsUpIcon';
import InformationCircleIcon from '@hugeicons/core-free-icons/InformationCircleIcon';
import Sun03Icon from '@hugeicons/core-free-icons/Sun03Icon';
import Notification01Icon from '@hugeicons/core-free-icons/Notification01Icon';
import Key01Icon from '@hugeicons/core-free-icons/Key01Icon';
import Mail01Icon from '@hugeicons/core-free-icons/Mail01Icon';
import SmartPhone01Icon from '@hugeicons/core-free-icons/SmartPhone01Icon';
import Restaurant01Icon from '@hugeicons/core-free-icons/Restaurant01Icon';
import ShoppingBasket01Icon from '@hugeicons/core-free-icons/ShoppingBasket01Icon';
import WaterEnergyIcon from '@hugeicons/core-free-icons/WaterEnergyIcon';
import FlashIcon from '@hugeicons/core-free-icons/FlashIcon';
import Car01Icon from '@hugeicons/core-free-icons/Car01Icon';
import Airplane01Icon from '@hugeicons/core-free-icons/Airplane01Icon';
import Home01Icon from '@hugeicons/core-free-icons/Home01Icon';
import ShoppingBag01Icon from '@hugeicons/core-free-icons/ShoppingBag01Icon';
import Ticket01Icon from '@hugeicons/core-free-icons/Ticket01Icon';
import HealthIcon from '@hugeicons/core-free-icons/HealthIcon';
import Book01Icon from '@hugeicons/core-free-icons/Book01Icon';
import { formatMoney } from './accounting';
import { observeMotionPreference, useMotionValue, motionDuration, type MotionPreference } from './motion';

export const radii = { button: 8, control: 12, surface: 16, navigation: 20 } as const;
export const balanceColor = (value: string | bigint, palette: Palette) => BigInt(value) > 0n ? palette.positive : BigInt(value) < 0n ? palette.negative : palette.muted;
const makeInputColors = (palette: Palette) => ({ selectionColor: Platform.OS === 'ios' ? palette.accent : palette.line, cursorColor: palette.accent, selectionHandleColor: palette.accent });
const icons = { offline: WifiDisconnected01Icon, key: Key01Icon, food: Restaurant01Icon, groceries: ShoppingBasket01Icon, water: WaterEnergyIcon, utilities: FlashIcon, transport: Car01Icon, travel: Airplane01Icon, rent: Home01Icon, shopping: ShoppingBag01Icon, entertainment: Ticket01Icon, health: HealthIcon, education: Book01Icon, info: InformationCircleIcon, feedback: Comment01Icon, thumbsUp: ThumbsUpIcon, attachment: Attachment01Icon, archive: Archive01Icon, add: Add01Icon, down: ArrowDown01Icon, back: ArrowLeft01Icon, next: ArrowRight01Icon, external: ArrowUpRight01Icon, check: CheckmarkCircle01Icon, history: Clock01Icon, bill: Invoice01Icon, settings: Settings01Icon, search: Search01Icon, me: UserCircleIcon, groups: UserGroupIcon, people: UserMultipleIcon, pay: Wallet01Icon, payment: MoneyExchange03Icon, remove: Delete02Icon, refresh: Refresh01Icon, export: Download01Icon, import: Upload01Icon, edit: PencilEdit02Icon, personAdd: UserAdd01Icon, privacy: Shield01Icon, help: HelpCircleIcon, appearance: Sun03Icon, notifications: Notification01Icon, mail: Mail01Icon, phone: SmartPhone01Icon };
export type IconName = keyof typeof icons;
export function Icon({ name, size = 22, color }: { name: IconName; size?: number; color?: string }) {
  const { palette } = useUI();
  return <HugeiconsIcon icon={icons[name]} size={size} color={color ?? palette.text} strokeWidth={1.7} />;
}
export function IconBadge({ name, size = 22 }: { name: IconName; size?: number }) {
  const { ui } = useUI();
  return <View style={ui.avatar}><Icon name={name} size={size} /></View>;
}
export function AmountText({ amount, style, ...props }: Omit<React.ComponentProps<typeof Text>, 'children'> & { amount: string }) {
  const { ui } = useUI();
  return <Text {...props} style={[ui.amount, style]}>{formatMoney(amount)}</Text>;
}
export function SectionHeading({ style, ...props }: React.ComponentProps<typeof Text>) {
  const { ui } = useUI();
  return <Text {...props} accessibilityRole="header" aria-level={2} style={[ui.section, style]} />;
}
export function ErrorText({ children, live = false }: { children: string; live?: boolean }) {
  const { ui } = useUI();
  return <Text accessibilityRole="alert" accessibilityLiveRegion={live ? 'polite' : undefined} style={ui.error}>{children}</Text>;
}
function makeTheme({ palette, elevation }: ThemeColors, dark: boolean): MD3Theme {
  const colors = palette, onAccent = dark ? '#161616' : '#FFFFFF', [level1, level2, level3, level4, level5] = elevation;
  return { ...(dark ? MD3DarkTheme : MD3LightTheme), roundness: 3, colors: {
    primary: colors.accent, onPrimary: onAccent, primaryContainer: colors.soft, onPrimaryContainer: colors.text,
    secondary: colors.accent, onSecondary: onAccent, secondaryContainer: colors.soft, onSecondaryContainer: colors.text,
    tertiary: colors.accent, onTertiary: onAccent, tertiaryContainer: colors.soft, onTertiaryContainer: colors.text,
    background: colors.background, onBackground: colors.text, surface: colors.surface, onSurface: colors.text,
    surfaceVariant: colors.soft, onSurfaceVariant: colors.muted,
    surfaceDisabled: dark ? 'rgba(255, 255, 255, 0.12)' : 'rgba(0, 0, 0, 0.12)', onSurfaceDisabled: dark ? 'rgba(255, 255, 255, 0.38)' : 'rgba(0, 0, 0, 0.38)',
    outline: colors.outline, outlineVariant: colors.line, error: colors.error, onError: onAccent, errorContainer: colors.soft, onErrorContainer: colors.error,
    inverseSurface: dark ? '#EAEAEA' : '#303030', inverseOnSurface: dark ? '#161616' : '#FAFAFA', inversePrimary: dark ? '#161616' : '#FFFFFF',
    shadow: '#000000', scrim: '#000000', backdrop: 'rgba(0, 0, 0, 0.4)',
    elevation: { level0: 'transparent', level1, level2, level3, level4, level5 },
  } };
}
type UITheme = MD3Theme & { palette: Palette; ui: ReturnType<typeof makeUI>; inputColors: ReturnType<typeof makeInputColors>; appearance: AppearancePreference; changeAppearance: (value: AppearancePreference) => Promise<void>; colorFamily: ColorFamily; changeColorFamily: (value: ColorFamily) => Promise<void>; motion: MotionPreference };
export function useUI() {
  const { palette, ui, inputColors, dark, appearance, changeAppearance, colorFamily, changeColorFamily, motion } = useTheme<UITheme>();
  return { palette, ui, inputColors, dark, appearance, changeAppearance, colorFamily, changeColorFamily, motion };
}
function LibraryIcon({ name, color, size }: { name: string; color?: string; size: number }) {
  const { palette } = useUI();
  const libraryIcons = { check: CheckmarkCircle01Icon, 'chevron-down': ArrowDown01Icon };
  return <HugeiconsIcon icon={libraryIcons[name as keyof typeof libraryIcons] ?? CheckmarkCircle01Icon} color={color ?? palette.accent} size={size} strokeWidth={1.7} />;
}
export function UIProvider({ children }: { children: React.ReactNode }) {
  const [fontsLoaded] = useFonts(appFontFaces);
  const system = useColorScheme();
  const [appearance, changeAppearance] = useSavedChoice<AppearancePreference>(initialBrowserAppearance(), savedAppearance, saveAppearance);
  const [colorFamily, changeColorFamily] = useSavedChoice<ColorFamily>(initialBrowserColorFamily(), savedColorFamily, saveColorFamily);
  const [motion, setMotion] = useState<MotionPreference>({ enabled: false, active: false });
  useWebInteractions(motion.enabled);
  useEffect(() => observeMotionPreference(value => setMotion(previous => previous.enabled === value.enabled && previous.active === value.active ? previous : value)), []);
  // Native controls and system bars follow the look; leaving Obsidian restores the saved mode.
  useEffect(() => { if (Platform.OS !== 'web') Appearance.setColorScheme(isDarkOnly(colorFamily) ? 'dark' : appearance === 'system' ? 'auto' : appearance); }, [appearance, colorFamily]);
  const dark = isDarkOnly(colorFamily) || (appearance === 'system' ? system === 'dark' : appearance === 'dark');
  const value = useMemo<UITheme>(() => {
    const colors = lookColors(colorFamily, dark), theme = makeTheme(colors, dark);
    return { ...theme, palette: colors.palette,
      fonts: fontsLoaded ? configureFonts({ config: { fontFamily: appFontFamily } }) : theme.fonts,
      ui: makeUI(colors.palette, fontsLoaded ? appFontFamily : undefined), inputColors: makeInputColors(colors.palette), appearance, changeAppearance, colorFamily, changeColorFamily, motion, animation: { scale: motion.enabled ? motionDuration.paperScale : 0 },
    };
  }, [dark, appearance, changeAppearance, colorFamily, changeColorFamily, motion, fontsLoaded]);
  useLayoutEffect(() => syncBrowserTheme(value.palette.background, dark), [value.palette.background, dark]);
  // PaperProvider overwrites animation.scale. Its public ThemeProvider also
  // supplies the corrected theme to Portals, without replacing their owner.
  return <PaperProvider theme={value} settings={{ icon: LibraryIcon, rippleEffectEnabled: false }}><ThemeProvider theme={value}>{children}</ThemeProvider></PaperProvider>;
}
function usePressFeedback(disabled: boolean) {
  const { motion } = useUI();
  const [pressed, setPressed] = useState(false);
  useEffect(() => { setPressed(false); }, [disabled, motion.active]);
  return { onPressIn: () => { if (!disabled && motion.active) setPressed(true); }, onPressOut: () => setPressed(false),
    pressedStyle: { opacity: pressed && !disabled && motion.active ? 0.65 : 1 } };
}
export function Button({ title, onPress, disabled = false, kind = 'secondary', icon, accessibilityLabel, compact = false, small = false, maxFontSizeMultiplier, style, contentStyle }: { maxFontSizeMultiplier?: number; contentStyle?: React.ComponentProps<typeof PaperButton>['contentStyle']; style?: React.ComponentProps<typeof PaperButton>['style']; compact?: boolean; small?: boolean; title: string; accessibilityLabel?: string; onPress: () => void; disabled?: boolean; kind?: 'primary' | 'secondary' | 'text' | 'danger' | 'outlined'; icon?: IconName | ((props: { size: number; color: string }) => React.ReactNode) }) {
  const { palette: colors, dark } = useUI();
  const { pressedStyle, ...press } = usePressFeedback(disabled);
  return <PaperButton {...press} maxFontSizeMultiplier={maxFontSizeMultiplier} hitSlop={{ top: small ? 8 : 6, bottom: small ? 8 : 6 }} compact={compact || small} accessibilityLabel={accessibilityLabel ?? title} mode={kind === 'text' ? 'text' : kind === 'outlined' ? 'outlined' : kind === 'secondary' ? 'contained-tonal' : 'contained'} onPress={onPress} disabled={disabled}
    icon={typeof icon === 'function' ? icon : icon ? ({ size, color }) => <Icon name={icon} size={small ? 16 : size} color={color} /> : undefined}
    buttonColor={kind === 'danger' ? colors.error : small ? dark ? '#303030' : '#E8E8E8' : undefined} textColor={kind === 'text' || small ? colors.text : kind === 'outlined' ? colors.accent : undefined} style={[{ borderRadius: small ? 6 : radii.button, minWidth: compact && icon ? 64 : 80, ...(kind === 'outlined' && { borderWidth: 1, borderColor: colors.accent }) }, pressedStyle, style]} contentStyle={[{ minHeight: small ? 28 : 36, ...(small && { paddingLeft: icon ? 4 : 0 }) }, contentStyle]} labelStyle={{ fontSize: 14, lineHeight: 20, fontWeight: '500', marginVertical: 0, marginHorizontal: compact && icon ? 4 : 20, ...(small && { marginLeft: icon ? 6 : 12, marginRight: 12 }) }}>{title}</PaperButton>;
}
export function IconAction({ name, label, onPress, disabled = false, hint }: { name: IconName; label: string; onPress: () => void; disabled?: boolean; hint?: string }) {
  const { pressedStyle, ...press } = usePressFeedback(disabled);
  return <Tooltip title={hint ?? label}><PaperIconButton {...press} accessibilityLabel={label} accessibilityHint={hint} disabled={disabled} onPress={onPress} hitSlop={4} size={22} style={[{ width: 44, height: 44, margin: 0 }, pressedStyle]} icon={({ size, color }) => <Icon name={name} size={size} color={color} />} /></Tooltip>;
}
export function SettingsRow({ icon, label, value, disabled = false, onPress, rowRef, danger = false, chevron = true, external = false }: { icon: IconName; label: string; value?: string; disabled?: boolean; onPress: () => void; rowRef?: React.Ref<React.ComponentRef<typeof View>>; danger?: boolean; chevron?: boolean; external?: boolean }) {
  const { ui, palette } = useUI();
  const { pressedStyle, ...press } = usePressFeedback(disabled);
  return <List.Item {...press} ref={rowRef as React.ComponentProps<typeof List.Item>['ref']} title={label} titleStyle={[ui.body, danger && { color: palette.error }]} titleNumberOfLines={2} accessibilityRole="button" accessibilityLabel={value ? `${label}, ${value}` : label} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
    style={[{ minHeight: 52, justifyContent: 'center', paddingVertical: 2, paddingLeft: 0, paddingRight: 0, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: palette.line }, pressedStyle]}
    left={props => <List.Icon {...props} icon={() => <Icon name={icon} size={22} color={danger ? palette.error : palette.text} />} />}
    right={() => <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, maxWidth: '48%' }}>{value !== undefined && <Text numberOfLines={1} ellipsizeMode="tail" style={[ui.caption, { flexShrink: 1 }]}>{value}</Text>}{chevron && <Icon name={external ? 'external' : 'next'} size={18} color={palette.muted} />}</View>} />;
}
const dateText = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
export function DateField({ label, value, onChange, disabled = false }: { label: string; value: string; onChange: (value: string) => void; disabled?: boolean }) {
  const { palette: colors, ui, dark } = useUI();
  const [open, setOpen] = useState(false);
  const fieldID = React.useId();
  const parsed = new Date(`${value}T12:00:00`), valid = !Number.isNaN(parsed.getTime()) && dateText(parsed) === value;
  if (Platform.OS === 'web') return <View style={{ gap: 4 }}><FieldLabel nativeID={fieldID} style={ui.label}>{label}</FieldLabel>{React.createElement('input', { id: fieldID, type: 'date', 'aria-label': label, value, disabled, onChange: (event: React.ChangeEvent<HTMLInputElement>) => onChange(event.target.value), style: { minHeight: 44, padding: '0 12px', borderRadius: radii.control, border: `1px solid ${colors.outline}`, backgroundColor: colors.surface, color: colors.text, fontFamily: ui.input.fontFamily ?? 'inherit', fontSize: 17, colorScheme: dark ? 'dark' : 'light' } })}</View>;
  return <View style={{ gap: 8 }}><Text style={ui.label}>{label}</Text>
    <PaperButton mode="outlined" accessibilityLabel={`${label}: ${value || 'Choose date'}`} disabled={disabled} onPress={() => setOpen(true)} icon={({ color, size }) => <HugeiconsIcon icon={Calendar03Icon} color={color} size={size} />} contentStyle={{ minHeight: Platform.OS === 'ios' ? 44 : 48 }} style={{ borderRadius: radii.control }}>
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
  const { ui, motion } = useUI();
  const [open, setOpen] = useState(initialOpen);
  const progress = useMotionValue(open ? 1 : 0, motion.enabled);
  return <View style={ui.disclosure}>
    <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen(value => !value)} style={ui.disclosureHeading}>
      <Text style={ui.section}>{title}</Text><Animated.View pointerEvents="none" accessible={false} style={{ transform: [{ rotate: progress.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '180deg'] }) }] }}><Icon name="down" size={20} /></Animated.View>
    </Pressable>
    {open && <Animated.View style={[ui.disclosureBody, motion.enabled && { opacity: progress.interpolate({ inputRange: [0, 1], outputRange: [0.88, 1] }), transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [8, 0] }) }] }]}>{children}</Animated.View>}
  </View>;
}
const makeUI = (colors: Palette, fontFamily?: string) => StyleSheet.create({
  section: { fontFamily, fontSize: 18, lineHeight: 24, fontWeight: '600', color: colors.text },
  body: { fontFamily, fontSize: 16, lineHeight: 23, color: colors.text },
  caption: { fontFamily, fontSize: 14, lineHeight: 20, color: colors.muted },
  label: { fontFamily, fontSize: 14, lineHeight: 20, fontWeight: '500', color: colors.muted },
  numeric: { fontFamily, fontSize: 32, lineHeight: 40, fontWeight: '600', color: colors.text, fontVariant: ['tabular-nums'] },
  amount: { fontFamily, fontSize: 17, lineHeight: 24, fontWeight: '600', color: colors.text, fontVariant: ['tabular-nums'], flexShrink: 0, textAlign: 'right' },
  input: { fontFamily, minHeight: 48, paddingHorizontal: 12, paddingVertical: 10, borderRadius: radii.control, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.outline, color: colors.text, fontSize: 17 },
  row: { minHeight: 52, paddingVertical: 6, flexDirection: 'row', alignItems: 'center', gap: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  rowBody: { flex: 1, minWidth: 0, gap: 2 },
  rowTitle: { fontFamily, fontSize: 17, lineHeight: 23, fontWeight: '500', color: colors.text },
  rowSub: { fontFamily, fontSize: 14, lineHeight: 20, color: colors.muted },
  avatar: { width: 36, height: 36, borderRadius: radii.control, backgroundColor: colors.soft, alignItems: 'center', justifyContent: 'center' },
  initials: { fontFamily, fontSize: 17, fontWeight: '600', color: colors.accent },
  notice: { fontFamily, backgroundColor: colors.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, borderRadius: radii.surface, padding: 12, color: colors.text, fontSize: 14, lineHeight: 21 },
  success: { color: colors.positive },
  warning: { color: colors.warning },
  error: { fontFamily, color: colors.error, fontSize: 15, lineHeight: 22 },
  disclosure: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  disclosureHeading: { minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  disclosureBody: { gap: 10, paddingBottom: 12 },
});
