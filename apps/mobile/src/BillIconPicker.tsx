import React, { useEffect, useRef, useState } from 'react';
import { FlatList, Platform, StyleSheet, View, useWindowDimensions } from 'react-native';
import { Text } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import DialogFocus from './DialogFocus';
import { categoryIcon, manualCategory, expenseIconChoices } from './categoryIcons';
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
  const { palette, ui } = useUI(), { width, height } = useWindowDimensions(), insets = useSafeAreaInsets();
  const [saving, setSaving] = useState(false), [queued, setQueued] = useState(false), [error, setError] = useState('');
  const [picked, setPicked] = useState<string | null>(null), [sheetWidth, setSheetWidth] = useState(Math.min(width, 560));
  const list = useRef<FlatList<(typeof expenseIconChoices)[number]>>(null);
  const lock = useRef(false), live = useRef(true), handedOff = useRef(false);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  useScreenRemovalLock(saving && !queued);
  const current = picked ?? manualCategory(category ?? 'general'), cell = Math.max(44, (sheetWidth - 70) / 4);
  const blocked = saving && !queued;
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
      if (live.current && !handedOff.current) { setError(cause instanceof Error ? cause.message : 'Could not save the icon. Try again.'); list.current?.scrollToOffset({ offset: 0, animated: false }); }
    } finally { lock.current = false; if (live.current) setSaving(false); }
  }
  const content = <DialogFocus active={active} busy={blocked} label="Choose bill icon" onEscape={close} style={{ flex: 1 }}>
    <FlatList ref={list} accessibilityRole="radiogroup" data={expenseIconChoices} numColumns={4} keyExtractor={item => item.category} initialNumToRender={20} nestedScrollEnabled
      style={{ flex: 1, marginTop: 44, width: '100%', maxWidth: 560, alignSelf: 'center' }} onLayout={event => setSheetWidth(event.nativeEvent.layout.width)}
      ListHeaderComponent={<View>
        {!!error && <View style={{ paddingBottom: 12 }}><ErrorText live>{error}</ErrorText></View>}
      </View>}
      columnWrapperStyle={{ gap: 10 }} contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: Math.max(insets.bottom, 16), gap: 10 }}
      renderItem={({ item }) => <Button kind="plain" accessibilityRole="radio" accessibilityLabel={item.label} accessibilityState={{ checked: current === item.category }} disabled={saving || disabled || !active} onPress={() => void choose(item.category)}
        style={{ flex: 1, minHeight: Math.max(96, cell + 24), paddingVertical: 10, paddingHorizontal: 4, gap: 8, borderWidth: 1.5, borderColor: current === item.category ? palette.accent : 'transparent', borderRadius: 14, backgroundColor: current === item.category ? palette.soft : 'transparent', alignItems: 'center', justifyContent: 'center' }}>
        <Icon name={item.icon} size={28} color={current === item.category ? palette.accent : palette.text} />
        <Text style={[ui.caption, { fontSize: 12, lineHeight: 16, color: palette.text, textAlign: 'center' }]}>{item.label}</Text>
      </Button>} />
    <View pointerEvents="box-none" style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 44, paddingHorizontal: 12, alignItems: 'flex-end' }}>
      {Platform.OS !== 'ios' && <View accessible={false} pointerEvents="none" style={{ position: 'absolute', top: 8, width: 36, height: 4, backgroundColor: palette.outline, borderRadius: 2, alignSelf: 'center' }} />}
      <Button iconOnly icon="close" kind="text" accessibilityLabel="Close icon picker" disabled={blocked} onPress={close} style={{ width: 44, height: 44 }} />
    </View>
  </DialogFocus>;
  if (Platform.OS !== 'web') return content;
  return <View style={{ flex: 1, justifyContent: 'flex-end', alignItems: 'center' }}>
    <Button kind="plain" accessible={false} disabled={blocked} style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.45)' }]} onPress={close} />
    <View style={{ width: Math.min(width, 560), height: Math.min(height * 0.65, height - insets.top - 12), backgroundColor: palette.surface, borderTopLeftRadius: 24, borderTopRightRadius: 24 }}>{content}</View>
  </View>;
}
