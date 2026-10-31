import ScrollView from './KeyboardScrollView';
import RowGroup from './RowGroup';
import React, { useContext } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { Dialog as PaperDialog, Text } from 'react-native-paper';
import { Button, Icon, useUI, type IconName } from './ui';
import { DialogContext } from './DialogContext';

function titleIcon(title: React.ReactNode): IconName {
  if (typeof title !== 'string') return 'info';
  if (/chat|message|report|feedback/i.test(title)) return 'feedback';
  if (/person|people|member|name|account/i.test(title)) return 'people';
  if (/pay|balance|upi/i.test(title)) return 'payment';
  if (/invite|email/i.test(title)) return 'mail';
  if (/appearance/i.test(title)) return 'appearance';
  if (/notification/i.test(title)) return 'notifications';
  if (/record|bill|change/i.test(title)) return 'bill';
  if (/update|recover/i.test(title)) return 'refresh';
  if (/MCP|access/i.test(title)) return 'key';
  return 'info';
}

function Title({ children, icon, style, ...props }: Omit<React.ComponentProps<typeof PaperDialog.Title>, 'ref'> & { icon?: IconName }) {
  const { ui, palette } = useUI(), { onDismiss, dismissable } = useContext(DialogContext);
  return <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, padding: 20, paddingBottom: 16 }}>
    {typeof children === 'string' && <Icon name={icon ?? titleIcon(children)} size={20} color={palette.muted} />}
    <Text {...props} accessibilityRole="header" style={[ui.section, { flex: 1, fontSize: 18, lineHeight: 24 }, style]}>{children}</Text>
    <Button kind="text" iconOnly icon="close" accessibilityLabel="Close dialog" disabled={!dismissable} onPress={onDismiss} style={{ width: 32, height: 32, minWidth: 32, paddingHorizontal: 6 }} />
  </View>;
}
function Content({ style, ...props }: React.ComponentProps<typeof PaperDialog.Content>) {
  return <PaperDialog.Content {...props} style={[{ paddingHorizontal: 20, paddingBottom: 16, flexShrink: 1 }, style]} />;
}
function Actions({ style, ...props }: React.ComponentProps<typeof PaperDialog.Actions>) {
  const { palette } = useUI();
  return <PaperDialog.Actions {...props} style={[{ paddingHorizontal: 20, paddingVertical: 12, gap: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.line, flexShrink: 0 }, style]} />;
}
export const Dialog = { Title, Content, Actions, ScrollArea: PaperDialog.ScrollArea };

// Inputs/choices scroll while the separate action footer remains reachable.
export function DialogScrollBody({ maxHeight = 520, gap = 12, paddingVertical = 12, paddingHorizontal, children }: {
  maxHeight?: number; gap?: number; paddingVertical?: number; paddingHorizontal?: number; children: React.ReactNode;
}) {
  const { bodyHeight } = useContext(DialogContext);
  return <Dialog.ScrollArea style={{ flexShrink: 1, maxHeight: Math.min(maxHeight, bodyHeight), paddingHorizontal: paddingHorizontal ?? 20, borderTopWidth: 0, borderBottomWidth: 0 }}>
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingVertical, gap, paddingRight: Platform.OS === 'web' ? 16 : 0 }}><RowGroup style={{ gap }}>{children}</RowGroup></ScrollView>
  </Dialog.ScrollArea>;
}

export function CancelDialogActions({ disabled, onCancel, children, cancelTitle = 'Cancel' }: {
  cancelTitle?: string; disabled: boolean; onCancel: () => void; children?: React.ReactNode;
}) {
  return <Dialog.Actions>
    <Button title={cancelTitle} kind="text" icon="close" disabled={disabled} onPress={onCancel} />
    {children}
  </Dialog.Actions>;
}

export function CloseDialogActions({ onClose, title = 'Done', ...button }: Omit<React.ComponentProps<typeof Button>, 'onPress'> & { onClose: () => void }) {
  return <Dialog.Actions><Button title={title} {...button} onPress={onClose} /></Dialog.Actions>;
}
