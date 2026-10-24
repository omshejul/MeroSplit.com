import React from 'react';
import { ActivityIndicator, Animated, KeyboardAvoidingView, Platform, Pressable, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { Text } from 'react-native-paper';
import { Icon, IconAction, radii, useUI } from './ui';
import { useMotionValue } from './motion';

export function AppFrame({ children, onTouchStart }: { children: React.ReactNode; onTouchStart?: () => void }) {
  const { palette, dark } = useUI();
  return <SafeAreaView style={{ flex: 1, backgroundColor: palette.background }} edges={['top', 'bottom']} onTouchStart={onTouchStart}>
    <StatusBar style={dark ? 'light' : 'dark'} />
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>{children}</KeyboardAvoidingView>
  </SafeAreaView>;
}

const pageWidthStyle = Platform.OS === 'web' ? { width: '100%' as const, maxWidth: 760, alignSelf: 'center' as const } : {};
export const pageContentStyle = { padding: 16, gap: 12, paddingBottom: 24, ...pageWidthStyle };

export function ScreenHeader({ title, busy, onBack, children }: { title: string; busy: boolean; onBack?: () => void; children?: React.ReactNode }) {
  const { palette } = useUI();
  return <View role="banner" style={styles.header}>
    {onBack && <IconAction name="back" label="Back" disabled={busy} onPress={onBack} />}
    <Text style={[styles.title, { color: palette.text }]} accessibilityRole="header" aria-level={1} numberOfLines={1} ellipsizeMode="tail" accessibilityLabel={title}>{title}</Text>
    {children}
    {busy && <ActivityIndicator accessibilityLabel="Working" color={palette.accent} />}
  </View>;
}

const tabs = [{ value: 'Groups', label: 'Groups', icon: 'groups' }, { value: 'Friends', label: 'People', icon: 'people' }, { value: 'Activity', label: 'Activity', icon: 'history' }, { value: 'Account', label: 'Me', icon: 'me' }] as const;
function TabButton({ item, selected, busy, onSelect }: { item: typeof tabs[number]; selected: boolean; busy: boolean; onSelect: (value: string) => void }) {
  const { palette, motion } = useUI();
  const opacity = useMotionValue(selected ? 1 : 0, motion.enabled);
  return <Pressable accessibilityRole={Platform.OS === 'web' ? 'button' : 'tab'} aria-current={Platform.OS === 'web' && selected ? 'page' : undefined} accessibilityState={Platform.OS === 'web' ? { disabled: busy } : { selected, disabled: busy }} disabled={busy} onPress={() => onSelect(item.value)} style={styles.tab}>
    <Animated.View pointerEvents="none" accessible={false} style={[StyleSheet.absoluteFill, { borderRadius: radii.surface, backgroundColor: palette.soft, opacity }]} />
    <View style={styles.tabContent}>
      <Icon name={item.icon} color={selected ? palette.accent : palette.muted} />
      <Text style={[styles.tabText, { color: selected ? palette.accent : palette.muted }]}>{item.label}</Text>
    </View>
  </Pressable>;
}
export function AppTabs({ selected, busy, onSelect }: { selected: string; busy: boolean; onSelect: (value: string) => void }) {
  const { palette } = useUI();
  return <View role="navigation" accessibilityLabel="Main navigation" style={pageWidthStyle}><View style={[styles.tabs, { backgroundColor: palette.surface }]} accessibilityRole={Platform.OS === 'web' ? undefined : 'tablist'}>
    {tabs.map(item => <TabButton key={item.value} item={item} selected={selected === item.value} busy={busy} onSelect={onSelect} />)}
  </View></View>;
}
const styles = StyleSheet.create({
  header: { ...pageWidthStyle, flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 56, paddingHorizontal: 16, paddingTop: 4, paddingBottom: 8 },
  title: { flex: 1, flexShrink: 1, minWidth: 0, fontSize: 24, lineHeight: 30, fontWeight: '600' },
  tabs: { flexDirection: 'row', marginHorizontal: 16, marginBottom: 8, borderRadius: radii.navigation, padding: 4, gap: 4 },
  tab: { flex: 1, minHeight: 48, alignItems: 'center', justifyContent: 'center', gap: 4, borderRadius: radii.surface, paddingVertical: 6 },
  tabContent: { zIndex: 1, alignItems: 'center', gap: 4 },
  tabText: { fontSize: 13, fontWeight: '500' },
});
