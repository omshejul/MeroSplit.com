import { Dialog } from './DialogParts';
import { APP_ORIGIN } from './appLinks';
import React, { useEffect, useRef, useState } from 'react';
import { Linking, Platform, Share, useWindowDimensions, View } from 'react-native';
import { Text } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { request } from './api';
import { DialogScrollBody } from './DialogParts';
import KeyboardDialog from './KeyboardDialog';
import type { Session } from './types';
import { Button, ErrorText, SettingsRow, useUI } from './ui';

type Connection = { id: string; client_name: string };
export default function MCPSettings({ session, busy, onBusyChange }: { session: Session; busy: boolean; onBusyChange: (value: boolean) => void }) {
  const { ui } = useUI();
  const { height } = useWindowDimensions(), { top, bottom } = useSafeAreaInsets();
  const [open, setOpen] = useState(false), [connections, setConnections] = useState<Connection[] | null>(null), [error, setError] = useState('');
  const [loading, setLoading] = useState(false), [working, setWorking] = useState(false);
  const row = useRef<React.ComponentRef<typeof View>>(null), mounted = useRef(true), inFlight = useRef(false), revision = useRef(0);
  const disabled = busy || working;
  const setup = `${APP_ORIGIN}/mcp/setup`;
  const prompt = `Connect MeroSplit to this client using the instructions at ${setup}, then verify with get_account_context.`;
  useEffect(() => {
    mounted.current = true; ++revision.current; setOpen(false); setConnections(null); setError(''); setLoading(false);
    return () => { mounted.current = false; ++revision.current; };
  }, [session.token, session.baseUrl]);
  async function load() {
    const current = ++revision.current;
    setLoading(true); setError('');
    try { const value = await request<{ connections: Connection[] }>(session, '/me/mcp'); if (mounted.current && current === revision.current) setConnections(value.connections); }
    catch { if (mounted.current && current === revision.current) setError('Could not load connections. Try again.'); }
    finally { if (mounted.current && current === revision.current) setLoading(false); }
  }
  function close() {
    if (disabled || inFlight.current) return;
    setOpen(false); requestAnimationFrame(() => row.current?.focus());
  }
  async function disconnect(id: string) {
    if (disabled || inFlight.current) return;
    inFlight.current = true; const current = ++revision.current; setWorking(true); setError(''); onBusyChange(true);
    try { await request(session, `/me/mcp/${encodeURIComponent(id)}`, 'DELETE'); if (mounted.current && current === revision.current) await load(); }
    catch { if (mounted.current && current === revision.current) setError('Could not disconnect this agent. Try again.'); }
    finally { inFlight.current = false; if (mounted.current) setWorking(false); onBusyChange(false); }
  }
  return <>
    <SettingsRow rowRef={row} icon="settings" label="Connect MCP" disabled={disabled} onPress={() => { if (!disabled && !inFlight.current) { setOpen(true); void load(); } }} />
    <KeyboardDialog visible={open} dismissable={!disabled} onDismiss={close} maxHeight={Math.max(0, height - top - bottom)}>
      <Dialog.Title aria-level={2}>Connect MCP</Dialog.Title>
      <DialogScrollBody maxHeight={440} gap={12}>
        <Text style={ui.caption}>Let an assistant read your groups and record bills or payments. It cannot send money.</Text>
        <SettingsRow icon="key" label="Setup instructions" external disabled={disabled} onPress={() => void Linking.openURL(setup).catch(() => setError('Could not open setup instructions. Try again.'))} />
        <Button title="Share setup prompt" icon="external" disabled={disabled} onPress={() => void Share.share({ message: prompt }).catch(() => setError('Could not share the setup prompt. Try again.'))} />
        <Text style={ui.label}>Connected agents</Text>
        {loading && <Text accessibilityLiveRegion="polite" style={ui.caption}>Loading connections…</Text>}
        {connections?.map(value => <View key={value.id} style={{ gap: 4 }}>
          <Text style={ui.rowTitle}>{value.client_name}</Text>
          <Button icon="close" title="Disconnect" accessibilityLabel={`Disconnect ${value.client_name}`} kind="text" disabled={disabled || loading} onPress={() => void disconnect(value.id)} />
        </View>)}
        {connections?.length === 0 && !loading && <Text style={ui.caption}>No connected agents</Text>}
        {!!error && <ErrorText live>{error}</ErrorText>}
        <Button title="Refresh" icon="refresh" kind="text" disabled={disabled || loading} onPress={() => { if (!disabled && !loading) void load(); }} />
      </DialogScrollBody>
      <Dialog.Actions><Button title="Done" icon="check" disabled={disabled} onPress={close} /></Dialog.Actions>
    </KeyboardDialog>
  </>;
}
