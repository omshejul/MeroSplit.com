// Synthetic payment recovery fixture. Never imported by production index.ts.
import React, { useEffect, useState } from 'react';
import { registerRootComponent } from 'expo';
import * as SplashScreen from 'expo-splash-screen';
import { ScrollView, Text, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import SettleForm from '../../src/SettleForm';
import { AppFrame, ScreenHeader } from '../../src/AppNavigation';
import { LoadingProvider } from '../../src/LoadingOverlay';
import { UIProvider, Button, useUI } from '../../src/ui';
import type { Group } from '../../src/types';

const payment = { sender: 'self', recipient: 'other', amount: '165869' };
const attempt = { id: 'expired-synthetic-attempt', ...payment, state: 'prepared' };
const original: Group = { id: 'synthetic-group', name: 'Weekend trip', version: 5,
  participants: [{ id: 'self', name: 'Riya', user_id: 1 }, { id: 'other', name: 'Asha', user_id: 2, payment_profile: { vpa: 'asha@example', version: 1, bank_verified: false } }],
  balances: { self: '-165869', other: '165869' }, transfers: [payment], payment_attempts: [attempt], expenses: [], settlements: [], activity: [] };

function Probe() {
  const { ui, dark, changeAppearance } = useUI();
  const [group, setGroup] = useState(original), [key, setKey] = useState(0), [offline, setOffline] = useState(false), [result, setResult] = useState('');
  useEffect(() => { void SplashScreen.hideAsync(); }, []);
  function reset(reported = false, disconnected = false) {
    setGroup({ ...original, payment_attempts: [{ ...attempt, state: reported ? 'reported' : 'prepared' }] });
    setOffline(disconnected); setResult(''); setKey(value => value + 1);
  }
  return <AppFrame><ScreenHeader title="Payment" busy={false} onBack={() => setResult('Balance opened')} />
    <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }}>
      <SettleForm key={key} group={group} initial={payment} selfId="self" busy={false} returnPayment={null}
        onReviewAttempt={async () => {}} onPrepareUPI={async () => { throw Error('Synthetic fixture does not open banking apps.'); }}
        onCancelUPI={async id => { if (offline) throw Error('Could not connect. Try again when you are online.'); if (id !== attempt.id) throw Error('Wrong attempt'); setGroup(value => ({ ...value, payment_attempts: [] })); setResult('Exact unpaid attempt cancelled'); }}
        onSave={async (value, queued) => { if (value.amount !== attempt.amount || value.attemptId !== attempt.id) throw Error('Wrong frozen payment'); setResult('Exact original payment recorded'); queued?.(); setGroup(value => ({ ...value, payment_attempts: [] })); }}
        onCancel={() => setResult('Balance opened')} onArmReturn={async () => { throw Error('No bank handoff in this fixture.'); }}
        onReturnPaymentChange={async () => {}} onResolveReturn={async () => {}} />
      <View style={{ gap: 8, marginTop: 16 }}>
        <Text style={ui.caption}>Synthetic QA controls</Text><Text style={ui.body}>{result}</Text>
        <Button title="Reset expired attempt" onPress={() => reset()} />
        <Button title="Reset reported attempt" onPress={() => reset(true)} />
        <Button title="Reset offline attempt" onPress={() => reset(false, true)} />
        <Button title="Toggle appearance" onPress={() => changeAppearance(dark ? 'light' : 'dark')} />
        <Text style={ui.caption}>{process.env.EXPO_PUBLIC_PAYMENT_RECOVERY_REVISION}</Text>
      </View>
    </ScrollView>
  </AppFrame>;
}
registerRootComponent(() => <SafeAreaProvider><UIProvider><LoadingProvider><Probe /></LoadingProvider></UIProvider></SafeAreaProvider>);
