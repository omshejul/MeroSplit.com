import LoadingOverlay, { useLoading } from './LoadingOverlay';
import React, { useEffect, useRef, useState } from 'react';
import { SectionList, Platform, StyleSheet, View, useWindowDimensions } from 'react-native';
import { Text } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import DialogFocus from './DialogFocus';
import { TextField } from './FormFields';
import { categoryIcon, manualCategory, expenseIconChoices, expenseIconGroups } from './categoryIcons';
import { useScreenRemovalLock } from './screenRemoval';
import { Button, ErrorText, Icon, useUI } from './ui';

export function BillIconButton({ category, reversed = false, disabled = false, onPress }: {
  category?: string | null; reversed?: boolean; disabled?: boolean; onPress?: () => void;
}) {
  const { palette } = useUI();
  const icon = <Icon name={reversed ? 'refresh' : categoryIcon(category)} size={28} color={palette.muted} />;
  return onPress && !reversed ? <Button kind="plain" accessibilityLabel="Change bill icon" disabled={disabled} onPress={onPress} hitSlop={8}
    style={{ width: 32, height: 32, justifyContent: 'center', alignItems: 'center', flexShrink: 0 }}>{icon}</Button>
    : <View accessible={false} style={{ width: 32, height: 32, justifyContent: 'center', alignItems: 'center' }}>{icon}</View>;
}

// The native stack owns presentation, dragging and dismissal. Keep only picker content here.
export default function BillIconPicker({ category, disabled = false, active = true, onSelect, onClose }: {
  category?: string | null; disabled?: boolean; active?: boolean;
  onSelect: (category: string, onQueued: () => void) => Promise<void>; onClose: () => void;
}) {
  const { palette, ui } = useUI(), { width, height, fontScale } = useWindowDimensions(), insets = useSafeAreaInsets();
  const columns = fontScale > 1.15 ? 3 : 4;
  const [query, setQuery] = useState('');
  const sections = expenseIconGroups.map(group => {
    const choices = group.choices.filter(item => `${group.title} ${item.label} ${item.category}`.toLowerCase().includes(query.trim().toLowerCase()));
    return { title: group.title, data: Array.from({ length: Math.ceil(choices.length / columns) }, (_, i) => choices.slice(i * columns, (i + 1) * columns)) };
  }).filter(section => section.data.length);
  const [saving, setSaving] = useState(false), [queued, setQueued] = useState(false), [error, setError] = useState('');
  const [picked, setPicked] = useState<string | null>(null), [sheetWidth, setSheetWidth] = useState(Math.min(width, 560));
  const list = useRef<SectionList<(typeof expenseIconChoices)[number][]>>(null);
  const lock = useRef(false), live = useRef(true), handedOff = useRef(false);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  useScreenRemovalLock(saving && !queued);
  const current = picked ?? manualCategory(category ?? 'general'), cell = Math.max(44, (sheetWidth - 40 - (columns - 1) * 10) / columns);
  const blocked = saving && !queued;
  useLoading(blocked);
  const close = () => { if (!lock.current || handedOff.current) onClose(); };
  async function choose(value: string) {
    if (!active || disabled || lock.current) return;
    lock.current = true; setSaving(true); setError('');
    try {
      await onSelect(value, () => {
        handedOff.current = true;
        if (!live.current) return;
        setPicked(value); setQueued(true); onClose();
      });
    } catch (cause) {
      if (live.current && !handedOff.current) { setError(cause instanceof Error ? cause.message : 'Could not save the icon. Try again.'); list.current?.getScrollResponder()?.scrollTo({ y: 0, animated: false }); }
    } finally { lock.current = false; if (live.current) setSaving(false); }
  }
  const content = <DialogFocus active={active} busy={blocked} label="Choose bill icon" onEscape={close} style={{ flex: 1 }}>
    <View style={{ marginTop: 44, paddingHorizontal: 20, width: '100%', maxWidth: 560, alignSelf: 'center' }}>
      <TextField label="Search categories" hideLabel placeholder="Search categories" value={query} onChangeText={setQuery} autoCorrect={false} autoCapitalize="none" />
    </View>
    <SectionList ref={list} accessibilityRole="radiogroup" sections={sections} keyboardShouldPersistTaps="handled" key={columns} keyExtractor={item => item[0].category} initialNumToRender={8} nestedScrollEnabled stickySectionHeadersEnabled={false}
      style={{ flex: 1, marginTop: 10, width: '100%', maxWidth: 560, alignSelf: 'center' }} onLayout={event => setSheetWidth(event.nativeEvent.layout.width)}
      ListEmptyComponent={<Text accessibilityLiveRegion="polite" style={[ui.caption, { paddingVertical: 20 }]}>No matching categories</Text>}
      ListHeaderComponent={<View>
        {!!error && <View style={{ paddingBottom: 12 }}><ErrorText live>{error}</ErrorText></View>}
      </View>}
      renderSectionHeader={({ section }) => <Text accessibilityRole="header" style={[ui.section, { paddingTop: 16, paddingBottom: 4 }]}>{section.title}</Text>}
      contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: Math.max(insets.bottom, 16), gap: 10 }}
      renderItem={({ item: row }) => <View style={{ flexDirection: 'row', gap: 10 }}>{row.map(item => <Button key={item.category} kind="plain" accessibilityRole="radio" accessibilityLabel={item.label} accessibilityState={{ checked: current === item.category }} disabled={saving || disabled || !active} onPress={() => void choose(item.category)}
        style={{ width: cell, minHeight: Math.max(96, cell + 24), paddingVertical: 10, paddingHorizontal: 4, gap: 8, borderWidth: 1.5, borderColor: current === item.category ? palette.accent : 'transparent', borderRadius: 14, backgroundColor: current === item.category ? palette.soft : 'transparent', alignItems: 'center', justifyContent: 'center' }}>
        <Icon name={item.icon} size={28} color={current === item.category ? palette.accent : palette.text} />
        <Text style={[ui.caption, { fontSize: 12, lineHeight: 16, color: palette.text, textAlign: 'center' }]}>{item.label}</Text>
      </Button>)}</View>} />
    <View pointerEvents="box-none" style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 44, paddingHorizontal: 12, alignItems: 'flex-end' }}>
      {Platform.OS !== 'ios' && <View accessible={false} pointerEvents="none" style={{ position: 'absolute', top: 8, width: 36, height: 4, backgroundColor: palette.outline, borderRadius: 2, alignSelf: 'center' }} />}
      <Button iconOnly icon="close" kind="text" accessibilityLabel="Close icon picker" disabled={blocked} onPress={close} style={{ width: 44, height: 44 }} />
    </View>
    <LoadingOverlay inline />
  </DialogFocus>;
  if (Platform.OS !== 'web') return content;
  return <View style={{ flex: 1, justifyContent: 'flex-end', alignItems: 'center' }}>
    <Button kind="plain" accessible={false} disabled={blocked} style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.45)' }]} onPress={close} />
    <View style={{ width: Math.min(width, 560), height: Math.min(height * 0.65, height - insets.top - 12), backgroundColor: palette.surface, borderTopLeftRadius: 24, borderTopRightRadius: 24 }}>{content}</View>
  </View>;
}
