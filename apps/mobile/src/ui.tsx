import Briefcase01Icon from '@hugeicons/core-free-icons/Briefcase01Icon';
import ShoppingBasket03Icon from '@hugeicons/core-free-icons/ShoppingBasket03Icon';
import TrashIcon from '@hugeicons/core-free-icons/TrashIcon';
import { useRowDivider } from './rowDividers';
import { animateLayout } from './layoutTransition';
import Tick02Icon from '@hugeicons/core-free-icons/Tick02Icon';
import AppleIcon from '@hugeicons/core-free-icons/AppleIcon';
import Unlink01Icon from '@hugeicons/core-free-icons/Unlink01Icon';
import EqualSignIcon from '@hugeicons/core-free-icons/EqualSignIcon';
import PercentIcon from '@hugeicons/core-free-icons/PercentIcon';
import PieChartIcon from '@hugeicons/core-free-icons/PieChartIcon';
import { DEFAULT_CURRENCY, setDefaultCurrency, type Currency } from './currency';
import SendHorizontalIcon from '@hugeicons/core-free-icons/SendHorizontalIcon';
import PersonAvatar from './Avatar';
import type { ProfilePhoto } from './types';
import CreditCardIcon from '@hugeicons/core-free-icons/CreditCardIcon';
import Dumbbell01Icon from '@hugeicons/core-free-icons/Dumbbell01Icon';
import GiftIcon from '@hugeicons/core-free-icons/GiftIcon';
import PawPrintIcon from '@hugeicons/core-free-icons/PawPrintIcon';
import RepairIcon from '@hugeicons/core-free-icons/RepairIcon';
import SoftwareIcon from '@hugeicons/core-free-icons/SoftwareIcon';
import TeaIcon from '@hugeicons/core-free-icons/TeaIcon';
import Train01Icon from '@hugeicons/core-free-icons/Train01Icon';
import React, { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { Appearance, Platform, Pressable, StyleSheet, useColorScheme, View } from 'react-native';
import { Tooltip, MD3DarkTheme, MD3LightTheme, PaperProvider, ThemeProvider, Text, useTheme, configureFonts } from 'react-native-paper';
import type { PressableProps, StyleProp, TextStyle } from 'react-native';
import { ToastProvider } from './Toast';
import type { MD3Theme } from 'react-native-paper';
import { savedAppearance, saveAppearance, savedColorFamily, saveColorFamily, savedCurrency, saveCurrency } from './native';
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
import Cancel01Icon from '@hugeicons/core-free-icons/Cancel01Icon';
import MoreVerticalIcon from '@hugeicons/core-free-icons/MoreVerticalIcon';
import Copy01Icon from '@hugeicons/core-free-icons/Copy01Icon';
import Attachment01Icon from '@hugeicons/core-free-icons/Attachment01Icon';
import Archive01Icon from '@hugeicons/core-free-icons/Archive01Icon';
import Add01Icon from '@hugeicons/core-free-icons/Add01Icon';
import ArrowDown01Icon from '@hugeicons/core-free-icons/ArrowDown01Icon';
import ArrowLeft01Icon from '@hugeicons/core-free-icons/ArrowLeft01Icon';
import ArrowRight01Icon from '@hugeicons/core-free-icons/ArrowRight01Icon';
import ArrowUpRight01Icon from '@hugeicons/core-free-icons/ArrowUpRight01Icon';
import CheckmarkCircle02Icon from '@hugeicons/core-free-icons/CheckmarkCircle02Icon';
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
import FlashIcon from '@hugeicons/core-free-icons/FlashIcon';
import Car01Icon from '@hugeicons/core-free-icons/Car01Icon';
import Airplane01Icon from '@hugeicons/core-free-icons/Airplane01Icon';
import Home01Icon from '@hugeicons/core-free-icons/Home01Icon';
import ShoppingBag01Icon from '@hugeicons/core-free-icons/ShoppingBag01Icon';
import Ticket01Icon from '@hugeicons/core-free-icons/Ticket01Icon';
import HealthIcon from '@hugeicons/core-free-icons/HealthIcon';
import Book01Icon from '@hugeicons/core-free-icons/Book01Icon';
import { formatMoney } from './accounting';
import { observeMotionPreference, motionDuration, type MotionPreference } from './motion';

export const radii = { button: 8, control: 12, surface: 16, navigation: 999 } as const;
export const balanceColor = (value: string | bigint, palette: Palette) => BigInt(value) > 0n ? palette.positive : BigInt(value) < 0n ? palette.negative : palette.muted;
const makeInputColors = (palette: Palette) => ({ selectionColor: Platform.OS === 'ios' ? palette.accent : palette.line, cursorColor: palette.accent, selectionHandleColor: palette.accent });
const icons = { software: SoftwareIcon, apple: AppleIcon, unlink: Unlink01Icon, tick: Tick02Icon, equal: EqualSignIcon, percent: PercentIcon, shares: PieChartIcon, send: SendHorizontalIcon, close: Cancel01Icon, more: MoreVerticalIcon, copy: Copy01Icon, offline: WifiDisconnected01Icon, key: Key01Icon, info: InformationCircleIcon, feedback: Comment01Icon, thumbsUp: ThumbsUpIcon, attachment: Attachment01Icon, archive: Archive01Icon, add: Add01Icon, down: ArrowDown01Icon, back: ArrowLeft01Icon, next: ArrowRight01Icon, external: ArrowUpRight01Icon, check: CheckmarkCircle02Icon, history: Clock01Icon, settings: Settings01Icon, search: Search01Icon, me: UserCircleIcon, groups: UserGroupIcon, people: UserMultipleIcon, pay: Wallet01Icon, payment: MoneyExchange03Icon, remove: Delete02Icon, refresh: Refresh01Icon, export: Download01Icon, import: Upload01Icon, edit: PencilEdit02Icon, personAdd: UserAdd01Icon, privacy: Shield01Icon, help: HelpCircleIcon, appearance: Sun03Icon, notifications: Notification01Icon, mail: Mail01Icon, phone: SmartPhone01Icon, bill: Invoice01Icon, food: Restaurant01Icon, tea: TeaIcon, groceries: ShoppingBasket03Icon, utilities: FlashIcon, transport: Car01Icon, train: Train01Icon, travel: Airplane01Icon, rent: Home01Icon, shopping: ShoppingBag01Icon, health: HealthIcon, education: Book01Icon, entertainment: Ticket01Icon, fitness: Dumbbell01Icon, work: Briefcase01Icon, gifts: GiftIcon, pets: PawPrintIcon, bankfees: CreditCardIcon, services: RepairIcon, garbage: TrashIcon };
export type IconName = keyof typeof icons;
export function Icon({ name, size = 26, color }: { name: IconName; size?: number; color?: string }) {
  const { palette } = useUI();
  return <HugeiconsIcon icon={icons[name]} size={size} color={color ?? palette.text} fill={name === 'apple' ? color ?? palette.text : 'none'} strokeWidth={1.7} />;
}
export function IconBadge({ name, size = 22 }: { name: IconName; size?: number }) {
  const { ui } = useUI();
  return <View style={ui.iconBadge}><Icon name={name} size={size} /></View>;
}
export function AmountText({ amount, style, ...props }: Omit<React.ComponentProps<typeof Text>, 'children'> & { amount: string }) {
  const { ui } = useUI();
  return <Text {...props} style={[ui.amount, style]}>{formatMoney(amount)}</Text>;
}
export function SectionHeading({ style, level = 2, ...props }: React.ComponentProps<typeof Text> & { level?: number }) {
  const { ui } = useUI();
  return <Text {...props} accessibilityRole="header" aria-level={level} style={[ui.section, style]} />;
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
type UITheme = MD3Theme & { palette: Palette; ui: ReturnType<typeof makeUI>; inputColors: ReturnType<typeof makeInputColors>; appearance: AppearancePreference; changeAppearance: (value: AppearancePreference) => Promise<void>; colorFamily: ColorFamily; changeColorFamily: (value: ColorFamily) => Promise<void>; motion: MotionPreference; currency: Currency; changeCurrency: (value: Currency) => Promise<void> };
export function useUI() {
  const { palette, ui, inputColors, dark, appearance, changeAppearance, colorFamily, changeColorFamily, motion, currency, changeCurrency } = useTheme<UITheme>();
  return { palette, ui, inputColors, dark, appearance, changeAppearance, colorFamily, changeColorFamily, motion, currency, changeCurrency };
}
function LibraryIcon({ name, color, size }: { name: string; color?: string; size: number }) {
  const { palette } = useUI();
  const libraryIcons = { check: CheckmarkCircle02Icon, 'chevron-down': ArrowDown01Icon };
  return <HugeiconsIcon icon={libraryIcons[name as keyof typeof libraryIcons] ?? CheckmarkCircle02Icon} color={color ?? palette.accent} size={size} strokeWidth={1.7} />;
}
export function UIProvider({ children }: { children: React.ReactNode }) {
  const [fontsLoaded] = useFonts(appFontFaces);
  const system = useColorScheme();
  const [appearance, changeAppearance] = useSavedChoice<AppearancePreference>(initialBrowserAppearance(), savedAppearance, saveAppearance);
  const [colorFamily, changeColorFamily] = useSavedChoice<ColorFamily>(initialBrowserColorFamily(), savedColorFamily, saveColorFamily);
  const [currency, changeCurrency] = useSavedChoice<Currency>(DEFAULT_CURRENCY, savedCurrency, saveCurrency, setDefaultCurrency);
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
      ui: makeUI(colors.palette, fontsLoaded ? appFontFamily : undefined), inputColors: makeInputColors(colors.palette), appearance, changeAppearance, colorFamily, changeColorFamily, currency, changeCurrency, motion, animation: { scale: motion.enabled ? motionDuration.paperScale : 0 },
    };
  }, [dark, appearance, changeAppearance, colorFamily, changeColorFamily, currency, changeCurrency, motion, fontsLoaded]);
  useLayoutEffect(() => syncBrowserTheme(value.palette.background, dark), [value.palette.background, dark]);
  // PaperProvider overwrites animation.scale. Its public ThemeProvider also
  // supplies the corrected theme to Portals, without replacing their owner.
  return <PaperProvider theme={value} settings={{ icon: LibraryIcon, rippleEffectEnabled: false }}><ThemeProvider theme={value}><ToastProvider>{children}</ToastProvider></ThemeProvider></PaperProvider>;
}
function usePressFeedback(disabled: boolean) {
  const { motion } = useUI();
  const [pressed, setPressed] = useState(false);
  useEffect(() => { setPressed(false); }, [disabled, motion.active]);
  return { onPressIn: () => { if (!disabled && motion.active) setPressed(true); }, onPressOut: () => setPressed(false),
    pressedStyle: { opacity: pressed && !disabled && motion.active ? 0.65 : 1 } };
}
type ButtonProps = Omit<PressableProps, 'children' | 'style'> & {
  title?: string; children?: React.ReactNode; kind?: 'primary' | 'secondary' | 'text' | 'danger' | 'outlined' | 'plain' | 'menu';
  icon?: IconName | ((props: { size: number; color: string }) => React.ReactNode); iconOnly?: boolean;
  compact?: boolean; small?: boolean; maxFontSizeMultiplier?: number;
  style?: PressableProps['style']; labelStyle?: StyleProp<TextStyle>;
};
// All app actions use this control, including icon, menu and custom-content buttons.
export const Button = React.forwardRef<React.ComponentRef<typeof View>, ButtonProps>(function Button({
  title, children, kind = 'secondary', icon, iconOnly = false, disabled = false, compact = false, small = false,
  maxFontSizeMultiplier, style, labelStyle, accessibilityLabel, accessibilityRole = 'button',
  accessibilityState, onFocus, onBlur, hitSlop, ...props
}, ref) {
  const { palette, ui, dark, motion } = useUI();
  const [focused, setFocused] = useState(false);
  const feedback = usePressFeedback(disabled);
  const plain = kind === 'plain', menu = kind === 'menu';
  const filled = kind === 'primary' || kind === 'danger';
  const color = filled ? dark ? '#161616' : '#FFFFFF' : palette.text;
  const size = small ? 16 : 18;
  icon ??= ({ Done: 'check', Close: 'close', Cancel: 'close', Save: 'check', Refresh: 'refresh', Retry: 'refresh' } as Record<string, IconName>)[title ?? ''];
  const glyph = typeof icon === 'function' ? icon({ size, color }) : icon ? <Icon name={icon} size={size} color={color} /> : null;
  return <Pressable {...props} ref={ref} disabled={disabled} accessibilityRole={accessibilityRole}
    onPress={event => { if (!disabled) { animateLayout(!!motion?.enabled); props.onPress?.(event); } }}
    accessibilityLabel={accessibilityLabel ?? title} accessibilityState={{ ...accessibilityState, disabled }}
    onPressIn={event => { feedback.onPressIn(); props.onPressIn?.(event); }} onPressOut={event => { feedback.onPressOut(); props.onPressOut?.(event); }}
    onPointerDown={event => { if (Platform.OS === 'web') setFocused(false); props.onPointerDown?.(event); }}
    hitSlop={hitSlop ?? (plain || menu ? undefined : { top: small ? 8 : 6, bottom: small ? 8 : 6, left: iconOnly ? 6 : 2, right: iconOnly ? 6 : 2 })}
    onFocus={event => {
      const target = event.currentTarget as unknown as { matches?: (selector: string) => boolean };
      setFocused(Platform.OS === 'web' && !!target.matches?.(':focus-visible')); onFocus?.(event);
    }} onBlur={event => { setFocused(false); onBlur?.(event); }}
    style={state => [!plain && { minHeight: menu ? 44 : small ? 28 : 32, minWidth: iconOnly ? 32 : compact ? 64 : 80,
      paddingHorizontal: iconOnly ? 6 : small ? 12 : 16, paddingVertical: iconOnly ? (small ? 4 : 6) : small ? 6 : 8,
      flexDirection: 'row', alignItems: 'center', justifyContent: menu ? 'flex-start' : 'center', gap: 8,
      borderRadius: 6, borderWidth: kind === 'secondary' || kind === 'outlined' ? 1 : 0,
      borderColor: palette.line, backgroundColor: kind === 'danger' ? palette.error : kind === 'primary' ? palette.accent : kind === 'secondary' ? palette.soft : 'transparent' },
      !plain && { opacity: disabled ? 0.4 : state.pressed ? 0.7 : 1 },
      Platform.OS === 'web' && focused && { outlineWidth: 2, outlineStyle: 'solid', outlineColor: palette.accent, outlineOffset: 2 },
      typeof style === 'function' ? style(state) : style]}>
    {children ?? <View pointerEvents="none" style={[{ flexDirection: 'row', alignItems: 'center', justifyContent: menu ? 'flex-start' : 'center', gap: 8, flexShrink: 1 }]}>
      {glyph && <View accessible={false} aria-hidden>{glyph}</View>}
      {!iconOnly && <Text maxFontSizeMultiplier={maxFontSizeMultiplier} style={[ui.body, { color, fontSize: 14, lineHeight: 20, fontWeight: '500', textAlign: menu ? 'left' : 'center', flexShrink: 1 }, labelStyle]}>{title}</Text>}
    </View>}
  </Pressable>;
});
export function IconAction({ name, label, onPress, disabled = false, hint }: { name: IconName; label: string; onPress: () => void; disabled?: boolean; hint?: string }) {
  return <Tooltip title={hint ?? label}><Button iconOnly icon={name} kind="text" accessibilityLabel={label} accessibilityHint={hint} disabled={disabled} onPress={onPress} style={{ width: 36, height: 36, paddingHorizontal: 6 }} /></Tooltip>;
}
export function SettingsRow({ icon, label, value, description, disabled = false, onPress, rowRef, danger = false, chevron = true, external = false, divider }: { divider?: boolean; icon: IconName; label: string; value?: string; description?: string; disabled?: boolean; onPress: () => void; rowRef?: React.Ref<React.ComponentRef<typeof View>>; danger?: boolean; chevron?: boolean; external?: boolean }) {
  const { ui, palette } = useUI(), separated = useRowDivider(divider);
  return <Button ref={rowRef} kind="plain" accessibilityLabel={[label, description, value].filter(Boolean).join(', ')} disabled={disabled} onPress={onPress}
    style={({ pressed }) => [{ minHeight: 48, paddingVertical: 10, flexDirection: 'row', alignItems: 'center', gap: 12, borderBottomWidth: separated ? StyleSheet.hairlineWidth : 0, borderBottomColor: palette.line, opacity: disabled ? 0.4 : 1 }, pressed && { backgroundColor: palette.soft }]}>
    <Icon name={icon} size={20} color={danger ? palette.error : palette.muted} />
    <View style={{ flex: 1, minWidth: 0, gap: 3 }}><Text style={[ui.body, danger && { color: palette.error }]}>{label}</Text>{!!description && <Text style={ui.caption}>{description}</Text>}</View>
    {value !== undefined && <Text numberOfLines={1} style={[ui.caption, { maxWidth: '45%' }]}>{value}</Text>}
    {chevron && <Icon name={external ? 'external' : 'next'} size={16} color={palette.muted} />}
  </Button>;
}
const dateText = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
export function DateField({ label, value, onChange, disabled = false }: { label: string; value: string; onChange: (value: string) => void; disabled?: boolean }) {
  const { palette: colors, ui, dark } = useUI();
  const [open, setOpen] = useState(false);
  const fieldID = React.useId();
  const parsed = new Date(`${value}T12:00:00`), valid = !Number.isNaN(parsed.getTime()) && dateText(parsed) === value;
  if (Platform.OS === 'web') return <View style={{ gap: 4 }}><FieldLabel nativeID={fieldID} style={ui.label}>{label}</FieldLabel>{React.createElement('input', { id: fieldID, type: 'date', 'aria-label': label, value, disabled, onChange: (event: React.ChangeEvent<HTMLInputElement>) => onChange(event.target.value), style: { minHeight: 44, padding: '0 12px', borderRadius: radii.control, border: `1px solid ${colors.outline}`, backgroundColor: colors.surface, color: colors.text, fontFamily: ui.input.fontFamily ?? 'inherit', fontSize: 17, colorScheme: dark ? 'dark' : 'light' } })}</View>;
  return <View style={{ gap: 8 }}><Text style={ui.label}>{label}</Text>
    <Button kind="outlined" accessibilityLabel={`${label}: ${value || 'Choose date'}`} disabled={disabled} onPress={() => setOpen(true)} icon={({ color, size }) => <HugeiconsIcon icon={Calendar03Icon} color={color} size={size} />} title={valid ? parsed.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : 'Choose date'} style={{ minHeight: 44, borderRadius: radii.control }} />
    {open && !disabled && <><DateTimePicker disabled={disabled} value={valid ? parsed : new Date()} mode="date" accentColor={colors.accent} themeVariant={dark ? 'dark' : 'light'} display={Platform.OS === 'ios' ? 'inline' : 'default'} onChange={(event, date) => { if (disabled) return; if (Platform.OS !== 'ios') setOpen(false); if (event.type === 'set' && date) onChange(dateText(date)); }} />
      {Platform.OS === 'ios' && <Button title="Close calendar" kind="text" onPress={() => setOpen(false)} />}</>}
  </View>;
}
export function Avatar({ name, photo, size = 36 }: { name: string; photo?: ProfilePhoto | null; size?: number }) {
  const { ui, palette } = useUI();
  return <PersonAvatar size={size} photo={photo} backgroundColor={palette.soft}><Text style={ui.initials}>{name.trim().split(/\s+/).map(word => word[0]).join('').slice(0, 2).toUpperCase()}</Text></PersonAvatar>;
}
const makeUI = (colors: Palette, fontFamily?: string) => StyleSheet.create({
  section: { fontFamily, fontSize: 18, lineHeight: 24, fontWeight: '600', color: colors.text },
  body: { fontFamily, fontSize: 16, lineHeight: 23, color: colors.text },
  caption: { fontFamily, fontSize: 14, lineHeight: 20, color: colors.muted },
  label: { fontFamily, fontSize: 14, lineHeight: 20, fontWeight: '500', color: colors.muted },
  numeric: { fontFamily, fontSize: 32, lineHeight: 40, fontWeight: '600', color: colors.text, fontVariant: ['tabular-nums'] },
  amount: { fontFamily, fontSize: 17, lineHeight: 24, fontWeight: '600', color: colors.text, fontVariant: ['tabular-nums'], flexShrink: 0, textAlign: 'right' },
  input: { fontFamily, minHeight: 48, paddingHorizontal: 12, paddingVertical: 10, borderRadius: radii.control, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.outline, color: colors.text, fontSize: 17 },
  row: { minHeight: 52, paddingVertical: 6, paddingHorizontal: 4, flexDirection: 'row', alignItems: 'center', gap: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  rowBody: { flex: 1, minWidth: 0, gap: 2 },
  rowTitle: { fontFamily, fontSize: 17, lineHeight: 23, fontWeight: '500', color: colors.text },
  rowSub: { fontFamily, fontSize: 14, lineHeight: 20, color: colors.muted },
  iconBadge: { width: 36, height: 36, borderRadius: radii.control, backgroundColor: colors.soft, alignItems: 'center', justifyContent: 'center' },
  initials: { fontFamily, fontSize: 17, fontWeight: '600', color: colors.accent },
  notice: { fontFamily, backgroundColor: colors.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, borderRadius: radii.surface, padding: 12, color: colors.text, fontSize: 14, lineHeight: 21 },
  success: { color: colors.positive },
  warning: { color: colors.warning },
  error: { fontFamily, color: colors.error, fontSize: 15, lineHeight: 22 },
});
