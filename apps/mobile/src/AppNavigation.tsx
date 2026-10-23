import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { Text } from 'react-native-paper';
import { Icon, IconAction, radii, useUI } from './ui';

export function ScreenHeader({ title, busy, onBack, children }: { title: string; busy: boolean; onBack?: () => void; children?: React.ReactNode }) {
  const { palette } = useUI();
  return <View style={styles.header}>
    {onBack && <IconAction name="back" label="Back" disabled={busy} onPress={onBack} />}
    <Text style={[styles.title, { color: palette.text }]} accessibilityRole="header" numberOfLines={1} ellipsizeMode="tail" accessibilityLabel={title}>{title}</Text>
    {children}
    {busy && <ActivityIndicator accessibilityLabel="Working" color={palette.accent} />}
  </View>;
}

const tabs = [{ value: 'Groups', label: 'Groups', icon: 'groups' }, { value: 'Friends', label: 'People', icon: 'people' }, { value: 'Activity', label: 'Activity', icon: 'history' }, { value: 'Account', label: 'Me', icon: 'me' }] as const;
export function AppTabs({ selected, busy, onSelect }: { selected: string; busy: boolean; onSelect: (value: string) => void }) {
  const { palette } = useUI();
  return <View style={[styles.tabs, { backgroundColor: palette.surface }]} accessibilityRole="tablist">
    {tabs.map(item => <Pressable key={item.value} accessibilityRole="tab" accessibilityState={{ selected: selected === item.value, disabled: busy }} disabled={busy} onPress={() => onSelect(item.value)} style={[styles.tab, selected === item.value && { backgroundColor: palette.soft }]}>
      <Icon name={item.icon} color={selected === item.value ? palette.accent : palette.muted} />
      <Text style={[styles.tabText, { color: selected === item.value ? palette.accent : palette.muted }]}>{item.label}</Text>
    </Pressable>)}
  </View>;
}
const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 56, paddingHorizontal: 16, paddingTop: 4, paddingBottom: 8 },
  title: { flex: 1, flexShrink: 1, minWidth: 0, fontSize: 24, lineHeight: 30, fontWeight: '600' },
  tabs: { flexDirection: 'row', marginHorizontal: 16, marginBottom: 8, borderRadius: radii.navigation, padding: 4, gap: 4 },
  tab: { flex: 1, minHeight: 48, alignItems: 'center', justifyContent: 'center', gap: 4, borderRadius: radii.surface, paddingVertical: 6 },
  tabText: { fontSize: 13, fontWeight: '500' },
});
