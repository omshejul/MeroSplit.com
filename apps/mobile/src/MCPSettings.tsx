import { useLoading } from './LoadingOverlay';
import { EmptyState, LoadingState } from './UIStates';
import { Dialog } from './DialogParts';
import { APP_ORIGIN } from './appLinks';
import React, { useEffect, useRef, useState } from 'react';
import { useWindowDimensions, View } from 'react-native';
import { Text } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { request } from './api';
import { copyText } from './clipboard';
import { DialogScrollBody } from './DialogParts';
import KeyboardDialog from './KeyboardDialog';
import type { Session } from './types';
import { Button, ErrorText, Icon, SettingsRow, useUI } from './ui';

type Connection = { id: string; client_name: string };
export default function MCPSettings({ session, busy, onBusyChange }: { session: Session; busy: boolean; onBusyChange: (value: boolean) => void }) {
  const { ui, palette } = useUI();
  const { height } = useWindowDimensions(), { top, bottom } = useSafeAreaInsets();
  const [open, setOpen] = useState(false), [connections, setConnections] = useState<Connection[] | null>(null), [error, setError] = useState('');
  const [loading, setLoading] = useState(false), [working, setWorking] = useState(false);
  const [copied, setCopied] = useState(false);
  const row = useRef<React.ComponentRef<typeof View>>(null), mounted = useRef(true), inFlight = useRef(false), revision = useRef(0);
  const disabled = busy || working;
  useLoading(open && (loading || working));
  const setup = `${APP_ORIGIN}/mcp/setup`;
  const prompt = `Connect MeroSplit to this client using the instructions at ${setup}, then verify with get_account_context.`;
  useEffect(() => {
    mounted.current = true; ++revision.current; setOpen(false); setConnections(null); setError(''); setLoading(false); setCopied(false);
    return () => { mounted.current = false; ++revision.current; };
  }, [session.token, session.baseUrl]);
  async function load() {
    const current = ++revision.current;
    setLoading(true); setError('');
    try { const value = await request<{ connections: Connection[] }>(session, '/me/mcp'); if (mounted.current && current === revision.current) setConnections(value.connections); }
    catch { if (mounted.current && current === revision.current) setError('Could not load connected devices. Close and reopen to try again.'); }
    finally { if (mounted.current && current === revision.current) setLoading(false); }
  }
  function close() {
    if (disabled || inFlight.current) return;
    setOpen(false); requestAnimationFrame(() => row.current?.focus());
  }
  async function copyPrompt() {
    if (disabled || inFlight.current) return;
    const current = revision.current;
    setCopied(false); if (error === 'Could not copy the prompt. Try again.') setError('');
    try { await copyText(prompt); if (mounted.current && current === revision.current) setCopied(true); }
    catch { if (mounted.current && current === revision.current) setError('Could not copy the prompt. Try again.'); }
  }
  async function disconnect(id: string) {
    if (disabled || inFlight.current) return;
    inFlight.current = true; const current = ++revision.current; setWorking(true); setError(''); onBusyChange(true);
    try { await request(session, `/me/mcp/${encodeURIComponent(id)}`, 'DELETE'); if (mounted.current && current === revision.current) await load(); }
    catch { if (mounted.current && current === revision.current) setError('Could not disconnect this agent. Try again.'); }
    finally { inFlight.current = false; if (mounted.current) setWorking(false); onBusyChange(false); }
  }
  return <>
    <SettingsRow rowRef={row} icon="key" label="Connect MCP" disabled={disabled} onPress={() => { if (!disabled && !inFlight.current) { setCopied(false); setOpen(true); void load(); } }} />
    <KeyboardDialog visible={open} dismissable={!disabled} onDismiss={close} maxHeight={Math.max(0, height - top - bottom)}>
      <Dialog.Title aria-level={2}>Connect MCP</Dialog.Title>
      <DialogScrollBody maxHeight={440} gap={20} paddingVertical={20}>
        <Text style={ui.caption}>Paste the prompt into your assistant to connect MeroSplit.</Text>
        <View accessibilityLiveRegion="polite"><Button title={copied ? 'Copied' : 'Copy prompt'} icon={copied ? 'check' : 'copy'} kind="primary" disabled={disabled} onPress={() => void copyPrompt()} style={{ minHeight: 48 }} /></View>
        <Text accessibilityRole="header" aria-level={3} style={ui.label}>Connected devices</Text>
        {loading && <LoadingState label="Loading connections…" />}
        {connections?.map(value => <View key={value.id} style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 12, padding: 12, borderRadius: 12, backgroundColor: palette.soft }}>
          <Icon name="software" />
          <View style={{ flex: 1, minWidth: 100, gap: 2 }}><Text style={ui.rowTitle}>{value.client_name}</Text><Text style={ui.caption}>Connected</Text></View>
          <Button title="Disconnect" accessibilityLabel={`Disconnect ${value.client_name}`} kind="text" small disabled={disabled || loading} onPress={() => void disconnect(value.id)} style={{ minHeight: 44 }} />
        </View>)}
        {connections?.length === 0 && !loading && <EmptyState message="No connected devices" />}
        {!!error && <ErrorText live>{error}</ErrorText>}
      </DialogScrollBody>
    </KeyboardDialog>
  </>;
}
