import RowGroup from './RowGroup';
import React, { useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import { Text } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import DialogFocus from './DialogFocus';
import NativeSheet from './NativeSheet';
import { Button, Icon, useUI, type IconName } from './ui';

export default function PeopleSheet({ visible, onDismiss, title, icon, total, count, disabled, maxHeight, children }: {
  visible: boolean; onDismiss: () => void; title: string; icon: IconName; total?: string; count?: number; disabled: boolean; maxHeight: number; children: React.ReactNode;
}) {
  const { ui, palette, motion } = useUI(), { height, width } = useWindowDimensions(), insets = useSafeAreaInsets();
  const [headerHeight, setHeaderHeight] = useState(100);
  const close = () => { if (!disabled) onDismiss(); };
  const content = <DialogFocus active={visible} busy={disabled} onEscape={close} label={title} style={{ flex: 1 }}>
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
      <ScrollView style={{ flex: 1, marginTop: headerHeight }} nestedScrollEnabled keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 12 }}><RowGroup>{children}</RowGroup></ScrollView>
      <View onLayout={event => setHeaderHeight(event.nativeEvent.layout.height)} style={{ position: 'absolute', top: 0, left: 0, right: 0, paddingHorizontal: 20, paddingTop: 20, paddingBottom: 16, gap: 6 }}>
        <View accessible={false} pointerEvents="none" style={{ position: 'absolute', top: 8, width: 36, height: 4, borderRadius: 2, backgroundColor: palette.outline, alignSelf: 'center' }} />
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}><Icon name={icon} /><Text accessibilityRole="header" style={[ui.section, { flex: 1 }]}>{title}</Text><Button title="Done" icon="tick" kind="text" compact accessibilityLabel={icon === 'people' ? 'Apply split' : 'Apply payers'} disabled={disabled || count === 0} onPress={close} /></View>
        {(total || count !== undefined) && <Text style={ui.caption}>{[total, count === undefined ? '' : `${count} selected`].filter(Boolean).join(' · ')}</Text>}
      </View>
    </KeyboardAvoidingView>
  </DialogFocus>;
  // Keep iOS dismissal in UIKit; native-stack removal crashes Fabric on the shipped runtime.
  if (Platform.OS === 'ios') return <Modal visible={visible} presentationStyle="pageSheet" animationType={motion.enabled ? 'slide' : 'none'} allowSwipeDismissal={!disabled} onRequestClose={close}><View style={{ flex: 1, backgroundColor: palette.surface }}>{content}</View></Modal>;
  if (Platform.OS !== 'web') return <NativeSheet visible={visible} disabled={disabled} onDismiss={onDismiss}>{content}</NativeSheet>;
  if (!visible) return null;
  return <Modal visible transparent animationType={motion.enabled ? 'fade' : 'none'} onRequestClose={close}><View style={{ flex: 1, justifyContent: 'flex-end', alignItems: 'center' }}>
    <Button kind="plain" accessible={false} disabled={disabled} onPress={close} style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.45)' }]} />
    <View style={{ width: Math.min(560, width), height: Math.max(0, Math.min(height * 0.65, maxHeight, height - insets.top - 12)), backgroundColor: palette.surface, borderTopLeftRadius: 24, borderTopRightRadius: 24 }}>{content}</View>
  </View></Modal>;
}
