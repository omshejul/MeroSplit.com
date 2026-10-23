import React from 'react';
import { Text, View } from 'react-native';
import { useUI } from './ui';
import type { Session } from './types';
import type { PushTarget } from './notifications';
export function usePushNotifications(_session: Session | null, _callbacks: { onOpen: (target: PushTarget | null) => Promise<void>; onForeground: () => Promise<void> }) {
  const noop = async () => {};
  return { state: { ready: true, enabled: false, optedIn: false, pendingOff: false, permission: 'denied' as const, working: false, error: '' }, enable: noop, disable: noop, refresh: noop, clear: noop };
}
export type PushControls = ReturnType<typeof usePushNotifications>;
export default function PushSettings(_props: { push: PushControls; busy: boolean; onBusyChange: (busy: boolean) => void }) {
  const { ui } = useUI();
  return <View><Text style={ui.body}>Bill notifications are available in the iOS and Android app.</Text><Text style={ui.caption}>This browser refreshes your account when you return or reconnect. Browser push is not enabled.</Text></View>;
}
