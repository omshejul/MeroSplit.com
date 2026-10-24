import React, { useRef } from 'react';
import { SettingsRow } from './ui';

export default function ExportData({ busy, onExport }: { busy: boolean; onExport: () => Promise<unknown> }) {
  const lock = useRef(false);
  return <SettingsRow label="Export data" icon="export" chevron={false} disabled={busy} onPress={() => {
    if (busy || lock.current) return;
    lock.current = true; void onExport().catch(() => {}).finally(() => { lock.current = false; });
  }} />;
}
