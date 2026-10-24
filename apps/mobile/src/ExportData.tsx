import React, { useRef } from 'react';
import { View } from 'react-native';
import { Text } from 'react-native-paper';
import { SettingsRow, useUI } from './ui';

export default function ExportData({ busy, onExport }: { busy: boolean; onExport: () => Promise<unknown> }) {
  const { ui } = useUI(), lock = useRef(false);
  return <View><SettingsRow label="Export data" icon="export" chevron={false} disabled={busy} onPress={() => {
    if (busy || lock.current) return;
    lock.current = true; void onExport().catch(() => {}).finally(() => { lock.current = false; });
  }} /><Text style={ui.caption}>Download your account data and saved work in one file.</Text></View>;
}
