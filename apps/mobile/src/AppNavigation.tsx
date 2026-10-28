import { pageWidthStyle } from './pageLayout';
import AppLogo from './AppLogo';
import FloatingActionContainer from './FloatingActionContainer';
import BottomSafeArea from './BottomSafeArea';
import AddActionButton from './AddActionButton';
import React from 'react';
import { Animated, KeyboardAvoidingView, Platform, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { Text } from 'react-native-paper';
import { Button, Icon, IconAction, radii, useUI } from './ui';
import { useMotionValue } from './motion';
import TabBarSurface from './TabBarSurface';

export function AppFrame({ children, onTouchStart }: { children: React.ReactNode; onTouchStart?: () => void }) {
  const { palette, dark } = useUI();
  // iOS scroll views own bottom insets so their surfaces reach the window edge.
  // Headers keep the top/cutout inset; sticky controls protect their own bottom edge.
  return <View style={{ flex: 1, backgroundColor: palette.background }} onTouchStart={onTouchStart}>
    <StatusBar style={dark ? 'light' : 'dark'} />
    <SafeAreaView style={{ flex: 1 }} edges={Platform.OS === 'ios' ? ['top', 'left', 'right'] : ['top', 'left', 'right', 'bottom']}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}><View style={{ flex: 1 }}>{children}</View></KeyboardAvoidingView>
    </SafeAreaView>
  </View>;
}

export { pageWidthStyle } from './pageLayout';
export const pageContentStyle = { padding: 16, gap: 12, paddingBottom: 24, ...pageWidthStyle };

export function ScreenHeader({ title, busy, onBack, onFeedback, brand = false, children, status }: { brand?: boolean; title: string; busy: boolean; onFeedback?: () => void; onBack?: () => void; children?: React.ReactNode; status?: React.ReactNode }) {
  const { palette } = useUI();
  return <View role="banner" style={styles.header}>
    {brand && <AppLogo />}
    {onBack && <IconAction name="back" label="Back" onPress={onBack} />}
    <View style={styles.titleArea}>
      <Text style={[styles.title, { color: palette.text }]} accessibilityRole="header" aria-level={1} numberOfLines={1} ellipsizeMode="tail" accessibilityLabel={title}>{title}</Text>
    </View>
    {status}
    {children}
    {onFeedback && <IconAction name="feedback" label="Feedback" onPress={onFeedback} />}

  </View>;
}

const tabs = [{ value: 'Groups', label: 'Groups', icon: 'groups' }, { value: 'Friends', label: 'People', icon: 'people' }, { value: 'Activity', label: 'Activity', icon: 'history' }, { value: 'Account', label: 'Me', icon: 'me' }] as const;
function TabButton({ item, selected, busy, onSelect }: { item: typeof tabs[number]; selected: boolean; busy: boolean; onSelect: (value: string) => void }) {
  const { palette, motion } = useUI();
  const opacity = useMotionValue(selected ? 1 : 0, motion.enabled);
  return <Button kind="plain" accessibilityRole={Platform.OS === 'web' ? 'button' : 'tab'} aria-current={Platform.OS === 'web' && selected ? 'page' : undefined} accessibilityState={Platform.OS === 'web' ? undefined : { selected }} onPress={() => onSelect(item.value)} style={styles.tab}>
    <Animated.View pointerEvents="none" accessible={false} style={[StyleSheet.absoluteFill, { borderRadius: radii.navigation, backgroundColor: palette.soft, opacity }]} />
    <View style={styles.tabContent}>
      <Icon name={item.icon} color={selected ? palette.accent : palette.muted} />
      <Text style={[styles.tabText, { color: selected ? palette.accent : palette.muted }]}>{item.label}</Text>
    </View>
  </Button>;
}
export function AppTabs({ selected, busy, onSelect }: { selected: string; busy: boolean; onSelect: (value: string) => void }) {
  return <BottomSafeArea role="navigation" accessibilityLabel="Main navigation" style={pageWidthStyle}><TabBarSurface style={styles.tabs}>
    {tabs.map(item => <TabButton key={item.value} item={item} selected={selected === item.value} busy={busy} onSelect={onSelect} />)}
  </TabBarSurface></BottomSafeArea>;
}
export function AddExpenseButton({ disabled, onPress }: { disabled: boolean; onPress: () => void }) {
  return <FloatingActionContainer><AddActionButton title="Add expense" disabled={disabled} onPress={onPress} /></FloatingActionContainer>;
}
const styles = StyleSheet.create({
  floating: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingBottom: 16 },
  floatingContent: { width: '100%', alignItems: 'flex-end', paddingHorizontal: 16 },
  header: { ...pageWidthStyle, flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 56, paddingHorizontal: 16, paddingTop: 4, paddingBottom: 8 },
  titleArea: { flex: 1, minWidth: 0, overflow: 'hidden', justifyContent: 'center' },
  title: { fontSize: 24, lineHeight: 30, fontWeight: '600' },
  tabs: { flexDirection: 'row', marginHorizontal: 16, marginBottom: 8, borderRadius: radii.navigation, padding: 4, gap: 4 },
  tab: { flex: 1, minHeight: 48, alignItems: 'center', justifyContent: 'center', gap: 4, borderRadius: radii.navigation, paddingVertical: 6 },
  tabContent: { zIndex: 1, alignItems: 'center', gap: Platform.OS === 'ios' ? 4 : 1 },
  tabText: { fontSize: 13, fontWeight: '500' },
});
