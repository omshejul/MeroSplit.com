import React from 'react';
import { Text, View } from 'react-native';
import { Icon, useUI } from './ui';
import type { Session } from './types';
import type { PushTarget } from './notifications';
export function usePushNotifications(_session: Session | null, _callbacks: { onOpen: (target: PushTarget | null) => Promise<void>; onForeground: () => Promise<void>; shouldSuppress?: (data: unknown) => boolean }) {
  const noop = async () => {};
  return { state: { ready: true, enabled: false, optedIn: false, pendingOff: false, permission: 'denied' as const, working: false, error: '' }, enable: noop, disable: noop, refresh: noop, clear: noop, clearReadPrompts: noop };
}
export type PushControls = ReturnType<typeof usePushNotifications>;
export default function PushSettings(_props: { push: PushControls; busy: boolean; onBusyChange: (busy: boolean) => void }) {
  const { ui } = useUI();
  return <View style={{ flexDirection: 'row', gap: 12, minHeight: 48 }}><View aria-hidden><Icon name="phone" /></View><View style={{ flex: 1, gap: 4 }}><Text style={ui.body}>Push notifications</Text><Text style={ui.caption}>Available in the mobile app. This browser refreshes while open.</Text></View></View>;
}
