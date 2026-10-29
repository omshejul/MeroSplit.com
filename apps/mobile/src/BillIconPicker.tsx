import React, { useEffect, useRef, useState } from 'react';
import { FlatList, Modal, StyleSheet, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import DialogFocus from './DialogFocus';
import { categoryIcon, expenseIconChoices } from './categoryIcons';
import { Button, ErrorText, Icon, useUI } from './ui';

export default function BillIconPicker({ category, reversed = false, disabled = false, onSelect }: {
  category?: string | null; reversed?: boolean; disabled?: boolean;
  onSelect?: (category: string, onQueued: () => void) => Promise<void>;
}) {
  const { palette, motion } = useUI(), { width, height } = useWindowDimensions(), insets = useSafeAreaInsets();
  const [open, setOpen] = useState(false), [saving, setSaving] = useState(false), [error, setError] = useState('');
  const [picked, setPicked] = useState<string | null>(null), lock = useRef(false);
  const trigger = useRef<React.ComponentRef<typeof View>>(null);
  useEffect(() => { setPicked(null); }, [category]);
  const current = picked ?? category ?? 'general', editable = !!onSelect && !disabled && !reversed;
  const sheetWidth = Math.min(width, 560), cell = (sheetWidth - 80) / 5;
  const close = () => { if (!lock.current) { setOpen(false); requestAnimationFrame(() => trigger.current?.focus()); } };
  async function choose(value: string) {
    if (!editable || lock.current) return;
    lock.current = true; setSaving(true); setError('');
    try {
      await onSelect!(value, () => { setPicked(value); setOpen(false); requestAnimationFrame(() => trigger.current?.focus()); });
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save the icon. Try again.'); }
    finally { lock.current = false; setSaving(false); }
  }
  const icon = <Icon name={reversed ? 'refresh' : categoryIcon(current)} size={28} color={palette.muted} />;
  return <>
    {onSelect && !reversed ? <Button ref={trigger} kind="plain" accessibilityLabel="Change bill icon" accessibilityState={{ expanded: open }} disabled={!editable || saving} onPress={() => { setError(''); setOpen(true); }} hitSlop={8} style={{ width: 32, height: 32, justifyContent: 'center', alignItems: 'center', flexShrink: 0 }}>{icon}</Button>
      : <View accessible={false} style={{ width: 32, height: 32, justifyContent: 'center', alignItems: 'center' }}>{icon}</View>}
    {open && <Modal visible transparent animationType={motion.enabled ? 'fade' : 'none'} statusBarTranslucent onRequestClose={close}>
      <View style={{ flex: 1, justifyContent: 'flex-end', alignItems: 'center' }}>
        <Button kind="plain" accessible={false} disabled={saving} style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.45)' }]} onPress={close} />
        <View style={{ width: sheetWidth, height: Math.max(0, Math.min(height * 0.65, height - insets.top - 12)), backgroundColor: palette.surface, borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingTop: 10 }}>
          <View accessible={false} style={{ width: 36, height: 4, backgroundColor: palette.outline, borderRadius: 2, alignSelf: 'center' }} />
          <DialogFocus active busy={saving} label="Choose bill icon" onEscape={close} style={{ flex: 1 }}>
            <View style={{ alignItems: 'flex-end', paddingHorizontal: 12 }}><Button iconOnly icon="close" kind="text" accessibilityLabel="Close icon picker" disabled={saving} onPress={close} style={{ width: 44, height: 44 }} /></View>
            {!!error && <View style={{ paddingHorizontal: 20, paddingBottom: 12 }}><ErrorText live>{error}</ErrorText></View>}
            <FlatList accessibilityRole="radiogroup" data={expenseIconChoices} numColumns={5} keyExtractor={item => item.category} initialNumToRender={25}
              initialScrollIndex={Math.max(0, Math.floor(expenseIconChoices.findIndex(item => item.category === current) / 5) - 1)}
              getItemLayout={(_, index) => ({ length: cell + 10, offset: (cell + 10) * index, index })}
              columnWrapperStyle={{ gap: 10 }} contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: Math.max(insets.bottom, 16), gap: 10 }}
              renderItem={({ item }) => <Button kind="plain" accessibilityRole="radio" accessibilityLabel={item.label} accessibilityState={{ checked: current === item.category }} disabled={saving || !editable} onPress={() => void choose(item.category)}
                style={{ flex: 1, height: cell, borderWidth: 1.5, borderColor: current === item.category ? palette.accent : 'transparent', borderRadius: 14, backgroundColor: current === item.category ? palette.soft : 'transparent', alignItems: 'center', justifyContent: 'center' }}>
                <Icon name={item.icon} size={28} color={current === item.category ? palette.accent : palette.text} />
              </Button>} />
          </DialogFocus>
        </View>
      </View>
    </Modal>}
  </>;
}
