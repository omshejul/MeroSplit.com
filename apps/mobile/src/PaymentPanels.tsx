import { DialogScrollBody, CancelDialogActions } from './DialogParts';
import KeyboardDialog from './KeyboardDialog';
import React, { useState } from 'react';
import { View } from 'react-native';
import { Dialog, Text } from 'react-native-paper';
import QRCode from 'react-native-qrcode-svg';
import { formatMoney } from './accounting';
import type { UPIApp, UPILaunchQuote } from './upi';
import { Button, ErrorText, useUI } from './ui';
import { copyText } from './clipboard';

export function PaymentAddress({ name, vpa }: { name: string; vpa: string }) {
  const { ui } = useUI();
  const [result, setResult] = useState<{ vpa: string; copied: boolean } | null>(null);
  async function copy() {
    try { await copyText(vpa); setResult({ vpa, copied: true }); }
    catch { setResult({ vpa, copied: false }); }
  }
  return <View style={{ gap: 4 }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={ui.caption}>{name}'s UPI ID</Text>
        <Text selectable style={ui.body}>{vpa}</Text>
      </View>
      <Button title={result?.vpa === vpa && result.copied ? 'Copied' : 'Copy'} kind="text" accessibilityLabel={`Copy ${name}'s UPI ID`} onPress={() => void copy()} />
    </View>
    {result?.vpa === vpa && !result.copied && <ErrorText live>Could not copy. Select the UPI ID to copy it.</ErrorText>}
  </View>;
}

export function WebPaymentQuote({ quote, url, disabled, onCopy, onOpen, onReview }: {
  quote: UPILaunchQuote; url: string; disabled: boolean;
  onCopy: (text: string) => void; onOpen: () => void; onReview: () => void;
}) {
  const { ui } = useUI();
  return <View style={{ gap: 7 }}>
    <Text style={ui.rowTitle}>{quote.recipient} · {formatMoney(quote.amount)}</Text>
    <View accessibilityRole="image" accessibilityLabel="Scan this UPI payment QR with your payment app" style={{ alignSelf: 'center', padding: 12, backgroundColor: '#FFFFFF' }}><QRCode value={url} size={200} quietZone={12} /></View>
    <PaymentAddress name={quote.recipient} vpa={quote.vpa} />
    <Button title="Copy payment link" kind="text" disabled={disabled} onPress={() => onCopy(url)} />
    <Button title="Open UPI app on this device" disabled={disabled} onPress={onOpen} />
    <Button title="Review payment" kind="primary" disabled={disabled} onPress={onReview} />
  </View>;
}

export function UPIAppChooser({ apps, disabled, onChoose, onDismiss }: {
  apps: UPIApp[] | null; disabled: boolean; onChoose: (app: UPIApp) => void; onDismiss: () => void;
}) {
  return <KeyboardDialog visible={apps !== null} onDismiss={onDismiss}>
    <Dialog.Title aria-level={2}>Pay with UPI</Dialog.Title>
    <DialogScrollBody maxHeight={360} paddingVertical={8} gap={8}>
      {apps?.map(app => <Button key={app.id} title={app.name} disabled={disabled} onPress={() => onChoose(app)} />)}
    </DialogScrollBody>
    <CancelDialogActions disabled={disabled} onCancel={onDismiss} />
  </KeyboardDialog>;
}
