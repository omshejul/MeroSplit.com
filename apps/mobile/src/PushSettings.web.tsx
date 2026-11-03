import React from 'react';
import { Text, View } from 'react-native';
import { useUI } from './ui';
import NotificationSwitch from './NotificationSwitch';
import type { NotificationChannels } from './useNotificationChannels';
import type { Session } from './types';
import type { PushTarget } from './notifications';
export function usePushNotifications(_session: Session | null, _callbacks: { onOpen: (target: PushTarget | null) => Promise<void>; onForeground: () => Promise<void>; shouldSuppress?: (data: unknown) => boolean }, _channels?: NotificationChannels) {
  const noop = async () => {};
  return { state: { ready: true, enabled: false, configured: false, installationId: undefined as string | undefined, optedIn: false, pendingOff: false, permission: 'denied' as const, working: false, saving: false, pending: false, error: '' }, enable: async () => false, disable: noop, refresh: noop, clear: noop, clearReadPrompts: noop };
}
export type PushControls = ReturnType<typeof usePushNotifications>;
export default function PushSettings(_props: { push: PushControls; busy: boolean; onBusyChange?: (busy: boolean) => void }) {
  return <NotificationSwitch icon="phone" label="Push notifications" checked={false} disabled onChange={() => {}} />;
}
export function PushStatus(_props: { push: PushControls; busy: boolean; hideSyncFeedback?: boolean }) {
  const { ui } = useUI();
  return <Text style={ui.caption}>Push notifications are available in the mobile app. This browser refreshes while open.</Text>;
}
