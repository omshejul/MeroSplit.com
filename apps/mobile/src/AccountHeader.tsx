import React from 'react';
import { View } from 'react-native';
import { Text } from 'react-native-paper';
import ProfilePhoto from './ProfilePhoto';
import type { Session } from './types';
import { useUI } from './ui';

export default function AccountHeader({ session, name, busy, onBusyChange, onPhotoChanged }: { session: Session; name: string; busy: boolean; onBusyChange: (value: boolean) => void; onPhotoChanged?: () => void | Promise<void> }) {
  const { ui } = useUI();
  return <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 8 }}>
    <View style={{ maxWidth: 120 }}><ProfilePhoto compact session={session} busy={busy} onBusyChange={onBusyChange} onChanged={onPhotoChanged} /></View>
    <View style={{ flex: 1, minWidth: 0 }}><Text style={ui.section} numberOfLines={2}>{name}</Text><Text style={ui.caption} numberOfLines={2}>{session.email}</Text></View>
  </View>;
}
