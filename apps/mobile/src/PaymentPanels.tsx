import { DialogScrollBody, CancelDialogActions } from './DialogParts';
import KeyboardDialog from './KeyboardDialog';
import React from 'react';
import { View } from 'react-native';
import { Dialog, Text } from 'react-native-paper';
import QRCode from 'react-native-qrcode-svg';
import { formatMoney } from './accounting';
import type { UPIApp, UPILaunchQuote } from './upi';
import { Button, useUI } from './ui';

export function WebPaymentQuote({ quote, url, disabled, onCopy, onOpen, onReview }: {
  quote: UPILaunchQuote; url: string; disabled: boolean;
  onCopy: (text: string) => void; onOpen: () => void; onReview: () => void;
}) {
  const { ui } = useUI();
  return <View style={{ gap: 7 }}>
    <Text style={ui.rowTitle}>{quote.recipient} · {formatMoney(quote.amount)}</Text>
    <View accessibilityRole="image" accessibilityLabel="Scan this UPI payment QR with your payment app" style={{ alignSelf: 'center', padding: 12, backgroundColor: '#FFFFFF' }}><QRCode value={url} size={200} quietZone={12} /></View>
    <Text selectable style={ui.body}>{quote.vpa}</Text>
    <Button title="Copy UPI address" kind="text" disabled={disabled} onPress={() => onCopy(quote.vpa)} />
    <Button title="Copy payment link" kind="text" disabled={disabled} onPress={() => onCopy(url)} />
    <Button title="Open UPI app on this device" disabled={disabled} onPress={onOpen} />
    <Button title="Review payment" kind="primary" disabled={disabled} onPress={onReview} />
  </View>;
}

export function UPIAppChooser({ apps, disabled, onChoose, onDismiss }: {
  apps: UPIApp[] | null; disabled: boolean; onChoose: (app: UPIApp) => void; onDismiss: () => void;
}) {
  const { ui } = useUI();
  return <KeyboardDialog visible={apps !== null} onDismiss={onDismiss}>
    <Dialog.Title>Pay with UPI</Dialog.Title>
    <Dialog.Content><Text style={ui.body}>Check the recipient and amount before paying.</Text></Dialog.Content>
    <DialogScrollBody maxHeight={360} paddingVertical={8} gap={8}>
      {apps?.map(app => <Button key={app.id} title={app.name} disabled={disabled} onPress={() => onChoose(app)} />)}
    </DialogScrollBody>
    <CancelDialogActions disabled={disabled} onCancel={onDismiss} />
  </KeyboardDialog>;
}
