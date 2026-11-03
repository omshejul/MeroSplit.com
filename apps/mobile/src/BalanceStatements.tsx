import { createSettingWriter, type SettingState } from './settingWriter';
import { ErrorState } from './UIStates';
import { LoadingState } from './UIStates';
import ChoiceGroup from './ChoiceGroup';
import React, { useEffect, useRef, useState } from 'react';
import { AppState, Platform, View } from 'react-native';
import { Text } from 'react-native-paper';
import * as Crypto from 'expo-crypto';
import { accountOwner, cachedRead, invalidateRead, rememberRead, request } from './api';

import { getDatabase } from './native';
import NotificationSwitch from './NotificationSwitch';
import { sendStatementRequest, type StatementDelivery as Delivery } from './statementRequest';
import type { Session } from './types';
import { Button, useUI } from './ui';

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

export default function BalanceStatements({ session, visible, emailEnabled, notificationsEnabled = true, busy }: { session: Session; visible: boolean; emailEnabled: boolean; notificationsEnabled?: boolean; busy: boolean; onBusyChange: (value: boolean) => void }) {
  const { ui } = useUI();
  const [state, setState] = useState<SettingState<Preferences | null>>(() => ({ value: cachedRead<Preferences>(session, `${path}/preferences`) ?? null, saving: false, error: '' }));
  const [error, setError] = useState(''), [working, setWorking] = useState(false);
  const mounted = useRef(true), lock = useRef(false), revision = useRef(0), activeSession = useRef(session); activeSession.current = session;
  const writer = useRef<ReturnType<typeof createSettingWriter<Preferences | null>> | null>(null);
  writer.current ??= createSettingWriter(state.value, async value => {
    if (!value) throw new Error('Balance statements are unavailable.');
    const active = activeSession.current;
    const saved = await request<Preferences>(active, `${path}/preferences`, 'PUT', { enabled: value.enabled, frequency: value.frequency });
    rememberRead(active, `${path}/preferences`, saved); return saved;
  }, value => { if (mounted.current) setState(value); }, (a, b) => a?.enabled === b?.enabled && a?.frequency === b?.frequency);
  const preferences = state.value;
  function accept(value: Preferences) { rememberRead(session, `${path}/preferences`, value); writer.current!.hydrate(value); }
  async function load(force = false) {
    if (lock.current || writer.current!.snapshot.saving || writer.current!.snapshot.error || !visible) return;
    if (force) invalidateRead(session, `${path}/preferences`);
    const stamp = ++revision.current;
    try { const value = await request<Preferences>(session, `${path}/preferences`); if (mounted.current && revision.current === stamp) { accept(value); setError(''); } }
    catch { if (mounted.current && revision.current === stamp) setError('Could not load balance statements. Try again.'); }
  }
  useEffect(() => { mounted.current = true; void load(); return () => { mounted.current = false; revision.current++; }; }, [session.token, visible, emailEnabled]);
  useEffect(() => {
    if (!visible || !preferences?.delivery || !['pending', 'sending'].includes(preferences.delivery.state) || preferences.delivery.error) return;
    const timer = setInterval(() => { if (Platform.OS === 'web' ? document.visibilityState === 'visible' : AppState.currentState === 'active') void load(true); }, 5000);
    return () => clearInterval(timer);
  }, [visible, preferences?.delivery?.id, preferences?.delivery?.state, preferences?.delivery?.error, session.token, emailEnabled]);
  function change(patch: Partial<Preferences>) {
    const value = writer.current!.snapshot.value;
    if (busy || lock.current || !value || !notificationsEnabled) return;
    ++revision.current; setError(''); writer.current!.change({ ...value, ...patch });
  }
  async function send() {
    if (busy || lock.current || writer.current!.snapshot.saving || writer.current!.snapshot.error) return;
    lock.current = true; ++revision.current; setWorking(true); setError('');
    try {
      const delivery = await sendStatementRequest(await getDatabase(), accountOwner(session), Crypto.randomUUID,
        command_id => request<Delivery>(session, `${path}/send`, 'POST', { command_id }));
      const value = writer.current!.snapshot.value;
      if (mounted.current && value) accept({ ...value, delivery });
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : 'Could not email your statement. Try again.'); }
    finally { lock.current = false; if (mounted.current) setWorking(false); }
  }
  const disabled = busy || working || !preferences;
  return <View role="region" accessibilityLabel="Balance statements" style={{ gap: 8 }}>
    {preferences && <>
      <NotificationSwitch icon="mail" label="Balance statements" checked={notificationsEnabled && preferences.enabled} disabled={disabled || !notificationsEnabled} onChange={enabled => change({ enabled })} />
      {state.saving && <Text accessibilityLiveRegion="polite" style={ui.caption}>Saving…</Text>}
      {notificationsEnabled && preferences.enabled && <>
        <ChoiceGroup label="Statement frequency" group="statement-frequency" options={[{value: 'monthly', label: 'Monthly'}, {value: 'weekly', label: 'Weekly'}]} selected={preferences.frequency} disabled={disabled} onChoose={frequency => change({ frequency })} />
        <Text style={ui.caption}>{!emailEnabled ? 'Turn on email notifications for scheduled statements.' : preferences.next_at ? `Next statement: ${new Date(preferences.next_at).toLocaleDateString('en-IN')}` : 'Scheduled statements are paused.'}</Text>
      </>}
      <Button title="Email statement now" icon="mail" disabled={disabled || state.saving || !!state.error || ["pending", "sending"].includes(preferences.delivery?.state ?? "")} onPress={() => void send()} />
      {working && <Text accessibilityLiveRegion="polite" style={ui.caption}>Sending…</Text>}
      <View style={{ minHeight: 24 }}><StatementDelivery delivery={preferences.delivery} /></View>
    </>}
    {!!(state.error || error) && <ErrorState error={state.error || error} retryLabel="Retry balance statements" disabled={busy || working} onRetry={state.error ? () => { ++revision.current; writer.current!.retry(); } : !preferences ? () => void load() : undefined} />}
    {!preferences && !error && <LoadingState label="Loading balance statements…" style={{ minHeight: 120, justifyContent: 'center' }} />}
  </View>;
}
