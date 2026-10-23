import React, { useEffect, useState } from 'react';
import { Linking, Share, View } from 'react-native';
import { Text } from 'react-native-paper';
import { request } from './api';
import type { Session } from './types';
import { Button, Disclosure, ErrorText, useUI } from './ui';

type Connection = { id: string; client_name: string; created_at: string; last_used_at: string | null };
export default function MCPSettings({ session, busy, onBusyChange }: { session: Session; busy: boolean; onBusyChange: (value: boolean) => void }) {
  const { ui } = useUI();
  const [connections, setConnections] = useState<Connection[] | null>(null), [error, setError] = useState('');
  const setup = `${session.baseUrl.replace(/\/$/, '')}/mcp/setup`;
  const prompt = `Connect MeroSplit to this client using the instructions at ${setup}, then verify with get_account_context.`;
  async function load() {
    try { setConnections((await request<{ connections: Connection[] }>(session, '/me/mcp')).connections); setError(''); }
    catch { setError('Could not load connected agents. Try again.'); }
  }
  useEffect(() => { let active = true; void request<{ connections: Connection[] }>(session, '/me/mcp').then(value => { if (active) setConnections(value.connections); }).catch(() => { if (active) setError('Could not load connected agents. Try again.'); }); return () => { active = false; }; }, [session.token]);
  async function disconnect(id: string) {
    if (busy) return;
    onBusyChange(true);
    try { await request(session, `/me/mcp/${encodeURIComponent(id)}`, 'DELETE'); await load(); }
    catch { setError('Could not disconnect this agent. Try again.'); }
    finally { onBusyChange(false); }
  }
  return <Disclosure title="Connect MCP">
    <Text style={ui.caption}>Let an agent read your groups and record bills or payments with your existing permissions. It cannot send money. You approve each connection in your browser.</Text>
    <Button title="Setup instructions" disabled={busy} onPress={() => void Linking.openURL(setup).catch(() => setError('Could not open setup instructions. Try again.'))} />
    <Text selectable style={ui.caption}>{prompt}</Text>
    <Button title="Share setup prompt" disabled={busy} onPress={() => void Share.share({ message: prompt }).catch(() => setError('Could not share this prompt. You can select and copy it above.'))} />
    {connections?.map(value => <View key={value.id} style={{ gap: 4 }}>
      <Text style={ui.rowTitle}>{value.client_name}</Text>
      <Text style={ui.caption}>Connected {new Date(value.created_at).toLocaleDateString('en-IN')}{value.last_used_at ? ` · Last used ${new Date(value.last_used_at).toLocaleDateString('en-IN')}` : ''}</Text>
      <Button title="Disconnect" accessibilityLabel={`Disconnect ${value.client_name}`} kind="text" disabled={busy} onPress={() => void disconnect(value.id)} />
    </View>)}
    {connections?.length === 0 && <Text style={ui.caption}>No connected agents.</Text>}
    {!!error && <ErrorText>{error}</ErrorText>}
    <Button title="Refresh connected agents" kind="text" disabled={busy} onPress={() => void load()} />
  </Disclosure>;
}
