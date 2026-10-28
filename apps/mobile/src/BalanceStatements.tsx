import { ErrorState } from './UIStates';
import { LoadingState } from './UIStates';
import ChoiceGroup from './ChoiceGroup';
import React, { useEffect, useRef, useState } from 'react';
import { AppState, Platform, View } from 'react-native';
import { Text } from 'react-native-paper';
import * as Crypto from 'expo-crypto';
import { accountOwner, request } from './api';
import { RadioChoice } from './FormFields';
import { getDatabase } from './native';
import NotificationSwitch from './NotificationSwitch';
import { sendStatementRequest, type StatementDelivery as Delivery } from './statementRequest';
import type { Session } from './types';
import { Button, ErrorText, useUI } from './ui';

type Preferences = { enabled: boolean; frequency: 'monthly' | 'weekly'; next_at: string | null; delivery: Delivery | null };
const path = '/me/balance-statements';

function StatementDelivery({ delivery }: { delivery: Delivery | null }) {
  const { ui } = useUI();
  if (!delivery) return null;
  const message = delivery.state === 'accepted' ? 'Statement accepted for email delivery.'
    : delivery.error === 'too_big' ? 'This statement is too large to email. Use Export data in your account.'
      : delivery.state === 'held' ? 'Delivery could not be confirmed. Check your inbox before sending another statement.'
    : delivery.state === 'cancelled' ? 'Statement cancelled after your records or settings changed.'
          : delivery.state === 'failed' ? 'Could not email this statement. Try again later.'
            : delivery.error ? 'Email is delayed. Your saved request will retry.' : 'Statement queued for email.';
  return <Text accessibilityLiveRegion="polite" style={ui.caption}>{message}</Text>;
}

export default function BalanceStatements({ session, visible, emailEnabled, busy, onBusyChange }: { session: Session; visible: boolean; emailEnabled: boolean; busy: boolean; onBusyChange: (value: boolean) => void }) {
  const { ui } = useUI();
  const [preferences, setPreferences] = useState<Preferences | null>(null), [error, setError] = useState(''), [working, setWorking] = useState(false);
  const mounted = useRef(true), lock = useRef(false), revision = useRef(0);
  async function load() {
    if (lock.current || !visible) return;
    const current = ++revision.current;
    try {
      const value = await request<Preferences>(session, `${path}/preferences`);
      if (mounted.current && revision.current === current) { setPreferences(value); setError(''); }
    } catch { if (mounted.current && revision.current === current) setError('Could not load balance statements. Try again.'); }
  }
  useEffect(() => { mounted.current = true; void load(); return () => { mounted.current = false; revision.current++; }; }, [session.token, visible, emailEnabled]);
  useEffect(() => {
    if (!visible || !preferences?.delivery || !['pending', 'sending'].includes(preferences.delivery.state) || preferences.delivery.error) return;
    const timer = setInterval(() => {
      if (Platform.OS === 'web' ? document.visibilityState === 'visible' : AppState.currentState === 'active') void load();
    }, 5000);
    return () => clearInterval(timer);
  }, [visible, preferences?.delivery?.id, preferences?.delivery?.state, preferences?.delivery?.error, session.token, emailEnabled]);
  async function run(action: () => Promise<void>) {
    if (busy || lock.current) return;
    lock.current = true; revision.current++; setWorking(true); setError(''); onBusyChange(true);
    try { await action(); }
    catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : 'Could not save this request. Try again.'); }
    finally { lock.current = false; if (mounted.current) setWorking(false); onBusyChange(false); }
  }
  async function update(enabled: boolean, frequency: Preferences['frequency']) {
    const value = await request<Preferences>(session, `${path}/preferences`, 'PUT', { enabled, frequency });
    if (mounted.current) setPreferences(value);
  }
  async function send() {
    const delivery = await sendStatementRequest(await getDatabase(), accountOwner(session), Crypto.randomUUID,
      command_id => request<Delivery>(session, `${path}/send`, 'POST', { command_id }));
    if (mounted.current) setPreferences(value => value && { ...value, delivery });
  }
  const disabled = busy || working || !preferences;
  return <View role="region" accessibilityLabel="Balance statements" style={{ gap: 8 }}>
    {preferences && <>
      <NotificationSwitch icon="mail" label="Balance statements" checked={preferences.enabled} disabled={disabled} onChange={enabled => void run(() => update(enabled, preferences.frequency))} />
      {preferences.enabled && <>
        <ChoiceGroup label="Statement frequency" group="statement-frequency" options={[{value: 'monthly', label: 'Monthly'}, {value: 'weekly', label: 'Weekly'}]} selected={preferences.frequency} disabled={disabled} onChoose={frequency => void run(() => update(true, frequency))} />
        <Text style={ui.caption}>{!emailEnabled ? 'Turn on email notifications for scheduled statements.' : preferences.next_at ? `Next statement: ${new Date(preferences.next_at).toLocaleDateString('en-IN')}` : 'Scheduled statements are paused.'}</Text>
      </>}
      <Button title="Email statement now" icon="mail" disabled={disabled || ["pending", "sending"].includes(preferences.delivery?.state ?? "")} onPress={() => void run(send)} />
      <StatementDelivery delivery={preferences.delivery} />
    </>}
    {!!error && <ErrorState error={error} retryLabel="Retry balance statements" disabled={busy || working} onRetry={!preferences ? () => void load() : undefined} />}
    {!preferences && !error && <LoadingState label="Loading balance statements…" />}
  </View>;
}
