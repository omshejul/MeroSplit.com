import RowGroup from './RowGroup';
import React, { useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import { Text } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import DialogFocus from './DialogFocus';
import { Button, Icon, useUI, type IconName } from './ui';

export default function PeopleSheet({ visible, onDismiss, title, icon, total, count, disabled, maxHeight, children }: {
  visible: boolean; onDismiss: () => void; title: string; icon: IconName; total?: string; count?: number; disabled: boolean; maxHeight: number; children: React.ReactNode;
}) {
  const { ui, palette, motion } = useUI(), { height, width } = useWindowDimensions(), insets = useSafeAreaInsets();
  const [available, setAvailable] = useState(height);
  const close = () => { if (!disabled) onDismiss(); };
  return <Modal visible={visible} transparent animationType={motion?.enabled ? 'fade' : 'none'} onRequestClose={close} statusBarTranslucent>
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
      <Button kind="plain" accessible={false} disabled={disabled} onPress={close} style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.45)' }]} />
      <View pointerEvents="box-none" onLayout={event => setAvailable(event.nativeEvent.layout.height)} style={{ flex: 1, justifyContent: 'flex-end', alignItems: 'center' }}>
        <View style={{ width: Math.min(560, width), maxHeight: Math.max(0, Math.min(maxHeight, available - insets.top - 12)), backgroundColor: palette.surface, borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingTop: 10, flexShrink: 1 }}>
          <View accessible={false} style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: palette.outline, alignSelf: 'center', marginBottom: 8 }} />
          <DialogFocus active={visible} busy={disabled} onEscape={close} label={title} style={{ flexShrink: 1 }}>
            <View style={{ paddingHorizontal: 20, paddingBottom: 16, gap: 6 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}><Icon name={icon} /><Text accessibilityRole="header" style={[ui.section, { flex: 1 }]}>{title}</Text><Button iconOnly icon="close" kind="text" accessibilityLabel="Close person selector" disabled={disabled} onPress={close} /></View>
              {(total || count !== undefined) && <Text style={ui.caption}>{[total, count === undefined ? '' : `${count} selected`].filter(Boolean).join(' · ')}</Text>}
            </View>
            <ScrollView style={{ flexShrink: 1, flexGrow: 0 }} keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 12 }}><RowGroup>{children}</RowGroup></ScrollView>
            <View style={{ padding: 20, paddingBottom: Math.max(16, insets.bottom), gap: 12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.line }}>
              {!!total && <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><Text style={ui.label}>Total</Text><Text style={ui.label}>{total}</Text></View>}
              <Button title={icon === 'people' ? 'Apply split' : 'Apply payers'} kind="primary" disabled={disabled || count === 0} onPress={close} />
            </View>
          </DialogFocus>
        </View>
      </View>
    </KeyboardAvoidingView>
  </Modal>;
}
