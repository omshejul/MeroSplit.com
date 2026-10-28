import { CloseDialogActions } from './DialogParts';
import { Dialog } from './DialogParts';
import { DialogScrollBody, CancelDialogActions } from './DialogParts';
import KeyboardDialog from './KeyboardDialog';

import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { Text } from 'react-native-paper';
import QRCode from 'react-native-qrcode-svg';
import { formatMoney } from './accounting';
import type { UPIApp, UPILaunchQuote } from './upi';
import { Button, ErrorText, Icon, radii, useUI } from './ui';
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
    <Text style={ui.rowTitle}>{quote.recipient} · {formatMoney(quote.amount, quote.currency)}</Text>
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
  const { palette } = useUI();
  useEffect(() => { if (!apps) setHelp(false); }, [apps]);
  return <KeyboardDialog visible={apps !== null} onDismiss={onDismiss}>
    <Dialog.Title aria-level={2}>Pay with UPI</Dialog.Title>
    <DialogScrollBody maxHeight={360} paddingVertical={8} paddingHorizontal={8} gap={8}>
      {apps?.map(app => app.id === 'google-pay' ? <View key={app.id} style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', backgroundColor: palette.soft, borderRadius: radii.button, opacity: disabled ? 0.5 : 1 }}>
        <Button kind="plain" accessibilityRole="button" accessibilityLabel={app.name} disabled={disabled} onPress={() => onChoose(app)} style={{ maxWidth: '100%', borderRadius: radii.button }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 8, paddingVertical: 4, minHeight: 44 }}>
            <UPIAppIcon app={app.id} /><Text style={{ color: palette.text, fontSize: 14, lineHeight: 20, fontWeight: '500', flexShrink: 1 }}>{app.name}</Text>
          </View>
        </Button>
        <Button kind="plain" accessibilityRole="button" accessibilityLabel="Why Google Pay might fail" disabled={disabled} onPress={() => setHelp(true)} style={{ justifyContent: 'center', minHeight: 44, paddingHorizontal: 4, maxWidth: '100%', borderRadius: radii.button }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 6, paddingVertical: 4, borderRadius: 12, backgroundColor: palette.surface }}>
            <Icon name="info" size={14} color={palette.text} /><Text style={{ color: palette.text, fontSize: 11, lineHeight: 16, fontWeight: '500', flexShrink: 1 }}>Might fail</Text>
          </View>
        </Button>
      </View> : <Button key={app.id} title={app.name} compact icon={() => <UPIAppIcon app={app.id} />} disabled={disabled} onPress={() => onChoose(app)} />)}
    </DialogScrollBody>
    <CancelDialogActions disabled={disabled} onCancel={onDismiss} />
    {recipient && <PaymentHelpDialog kind="google-pay" visible={help && apps !== null} name={recipient.name} vpa={recipient.vpa} onClose={() => setHelp(false)} />}
  </KeyboardDialog>;
}

export function PaymentHelpDialog({ kind = 'failed', visible, name, vpa, onClose }: { kind?: 'failed' | 'google-pay'; visible: boolean; name: string; vpa: string; onClose: () => void }) {
  const { ui } = useUI();
  return <KeyboardDialog visible={visible} onDismiss={onClose}>

      <Dialog.Title aria-level={2}>{kind === 'failed' ? 'Payment failed' : 'Google Pay might fail'}</Dialog.Title>
      <DialogScrollBody maxHeight={380} gap={12}>
        <Text style={ui.body}>{kind === 'google-pay' ? 'Google Pay may reject payment links to personal UPI IDs. If that happens, copy the UPI ID and pay inside Google Pay.' : 'Bank or network issues, payment limits, or the recipient’s UPI ID can stop a payment. Some app-to-app payments may also be rejected.'}</Text>
        {kind === 'failed' && <Text style={ui.body}>If the payment failed and no money was debited, copy this UPI ID and try paying inside your UPI app. If it is pending or money was debited, check that payment before trying again.</Text>}
        <PaymentAddress name={name} vpa={vpa} />
      </DialogScrollBody>
      <CloseDialogActions title="Close payment help" kind="text" onClose={onClose} />

  </KeyboardDialog>;
}
