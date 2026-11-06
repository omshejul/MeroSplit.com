import { ErrorState } from './UIStates';
import ChoiceGroup from './ChoiceGroup';
import React, { useEffect, useRef, useState } from 'react';
import { AppState, Platform, View, useWindowDimensions } from 'react-native';
import { Text } from 'react-native-paper';
import * as Crypto from 'expo-crypto';
import { accountOwner, request } from './api';

import { getDatabase } from './native';
import KeyboardDialog from './KeyboardDialog';
import { Dialog, DialogScrollBody } from './DialogParts';
import type { NotificationChannels } from './useNotificationChannels';
import { sendStatementRequest, type StatementDelivery as Delivery } from './statementRequest';
import type { Session } from './types';
import { Button, SettingsRow, useUI } from './ui';

type Preferences = { enabled: boolean; frequency: 'monthly' | 'weekly'; next_at: string | null; delivery: Delivery | null };
const path = '/me/balance-statements';

function StatementDelivery({ delivery }: { delivery: Delivery | null }) {
  const { ui } = useUI();
  if (!delivery) return null;
  const message = delivery.state === 'accepted' ? 'Your statement has been emailed.'
    : delivery.error === 'too_big' ? 'This statement is too large to email. Use Export data in your account.'
      : delivery.state === 'held' ? 'Delivery could not be confirmed. Check your inbox before sending another statement.'
    : delivery.state === 'cancelled' ? 'Statement cancelled after your records or settings changed.'
          : delivery.state === 'failed' ? 'Could not email this statement. Try again later.'
            : delivery.error ? 'Your email is delayed. We will try again automatically.' : 'Your statement will be emailed.';
  return <Text accessibilityLiveRegion="polite" style={ui.caption}>{message}</Text>;
}

export default function BalanceStatements({ session, visible, channels, busy }: { session: Session; visible: boolean; channels: NotificationChannels; busy: boolean }) {
  const { ui } = useUI(), { height } = useWindowDimensions();
  const [delivery, setDelivery] = useState<Delivery | null>(null), [error, setError] = useState(''), [working, setWorking] = useState(false), [frequencyOpen, setFrequencyOpen] = useState(false);
  const mounted = useRef(true), lock = useRef(false);
  const preferences = channels.state.value;
  async function load() {
    try { const value = await request<Preferences>(session, `${path}/preferences`); if (mounted.current) setDelivery(value.delivery); }
    catch { /* Delivery receipts are refreshed independently of local preferences. */ }
  }
  useEffect(() => { mounted.current = true; if (visible) void load(); return () => { mounted.current = false; }; }, [session.token, visible]);
  useEffect(() => {
    if (!visible || !delivery || !['pending', 'sending'].includes(delivery.state) || delivery.error) return;
    const timer = setInterval(() => { if (Platform.OS === 'web' ? document.visibilityState === 'visible' : AppState.currentState === 'active') void load(); }, 5000);
    return () => clearInterval(timer);
  }, [visible, delivery?.id, delivery?.state, delivery?.error, session.token]);
  async function send() {
    if (busy || lock.current || !preferences?.email_notifications) return;
    lock.current = true; setWorking(true); setError('');
    try {
      if (!await channels.retry()) throw new Error('Reconnect to email your statement.');
      const result = await sendStatementRequest(await getDatabase(), accountOwner(session), Crypto.randomUUID,
        command_id => request<Delivery>(session, `${path}/send`, 'POST', { command_id }));
      if (mounted.current) setDelivery(result);
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : 'Could not email your statement. Try again.'); }
    finally { lock.current = false; if (mounted.current) setWorking(false); }
  }
  return <View role="region" accessibilityLabel="Balance statements" style={{ gap: 8 }}>
    <Text style={[ui.caption, { paddingTop: 8 }]}>Balance statements</Text>
    <SettingsRow icon="history" label="Frequency" value={!preferences?.statement_enabled ? 'Not scheduled' : preferences.statement_frequency === 'weekly' ? 'Weekly' : 'Monthly'} disabled={busy} onPress={() => setFrequencyOpen(true)} />
    <Button title="Email statement now" icon="mail" kind="outlined" disabled={busy || working || ['pending', 'sending'].includes(delivery?.state ?? '')} onPress={() => void send()} />
    {working && <Text accessibilityLiveRegion="polite" style={ui.caption}>Sending…</Text>}
    <StatementDelivery delivery={delivery} />
    {!!error && <ErrorState error={error} />}
    <KeyboardDialog label="Statement frequency" placement="bottom" visible={frequencyOpen} dismissable={!busy} onDismiss={() => setFrequencyOpen(false)}><Dialog.Title icon="history">Statement frequency</Dialog.Title><DialogScrollBody maxHeight={Math.min(height * .6, 240)}>
      <ChoiceGroup group="statement-frequency" options={[{ value: 'monthly', label: 'Monthly' }, { value: 'weekly', label: 'Weekly' }]} selected={preferences?.statement_enabled ? preferences.statement_frequency : ''} disabled={busy} onChoose={statement_frequency => { setFrequencyOpen(false); void channels.change({ statement_frequency: statement_frequency as 'weekly' | 'monthly' }).catch(() => {}); }} />
    </DialogScrollBody></KeyboardDialog>
  </View>;
}
