import { DialogScrollBody, CancelDialogActions } from './DialogParts';
import KeyboardDialog from './KeyboardDialog';
import DialogFocus from './DialogFocus';
import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { Chip, Dialog, Text } from 'react-native-paper';
import QRCode from 'react-native-qrcode-svg';
import { formatMoney } from './accounting';
import type { UPIApp, UPILaunchQuote } from './upi';
import { Button, ErrorText, Icon, useUI } from './ui';
import { copyText } from './clipboard';
import UPIAppIcon from './UPIAppIcon';

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

export function UPIAppChooser({ apps, recipient, disabled, onChoose, onDismiss }: {
  apps: UPIApp[] | null; recipient?: { name: string; vpa: string } | null; disabled: boolean; onChoose: (app: UPIApp) => void; onDismiss: () => void;
}) {
  const [help, setHelp] = useState(false);
  useEffect(() => { if (!apps) setHelp(false); }, [apps]);
  return <KeyboardDialog visible={apps !== null} onDismiss={onDismiss}>
    <Dialog.Title aria-level={2}>Pay with UPI</Dialog.Title>
    <DialogScrollBody maxHeight={360} paddingVertical={8} paddingHorizontal={8} gap={8}>
      {apps?.map(app => <View key={app.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <View style={{ flex: 1 }}><Button title={app.name} compact icon={() => <UPIAppIcon app={app.id} />} disabled={disabled} onPress={() => onChoose(app)} /></View>
        {app.id === 'google-pay' && <Chip compact disabled={disabled} accessibilityLabel="Why Google Pay might fail" icon={({ color }) => <Icon name="info" size={16} color={color} />} onPress={() => setHelp(true)} style={{ minHeight: 44, justifyContent: 'center', borderRadius: 22 }} textStyle={{ fontSize: 12 }}>Might fail</Chip>}
      </View>)}
    </DialogScrollBody>
    <CancelDialogActions disabled={disabled} onCancel={onDismiss} />
    {recipient && <PaymentHelpDialog kind="google-pay" visible={help && apps !== null} name={recipient.name} vpa={recipient.vpa} onClose={() => setHelp(false)} />}
  </KeyboardDialog>;
}

export function PaymentHelpDialog({ kind = 'failed', visible, name, vpa, onClose }: { kind?: 'failed' | 'google-pay'; visible: boolean; name: string; vpa: string; onClose: () => void }) {
  const { ui } = useUI();
  return <KeyboardDialog visible={visible} onDismiss={onClose}>
    <DialogFocus active={visible} onEscape={onClose}>
      <Dialog.Title aria-level={2}>{kind === 'failed' ? 'Payment failed' : 'Google Pay might fail'}</Dialog.Title>
      <DialogScrollBody maxHeight={380} gap={12}>
        <Text style={ui.body}>{kind === 'google-pay' ? 'Google Pay may reject payment links to personal UPI IDs. If that happens, copy the UPI ID and pay inside Google Pay.' : 'Bank or network issues, payment limits, or the recipient’s UPI ID can stop a payment. Some app-to-app payments may also be rejected.'}</Text>
        {kind === 'failed' && <Text style={ui.body}>If the payment failed and no money was debited, copy this UPI ID and try paying inside your UPI app. If it is pending or money was debited, check that payment before trying again.</Text>}
        <PaymentAddress name={name} vpa={vpa} />
      </DialogScrollBody>
      <Dialog.Actions><Button title="Done" kind="text" onPress={onClose} /></Dialog.Actions>
    </DialogFocus>
  </KeyboardDialog>;
}
