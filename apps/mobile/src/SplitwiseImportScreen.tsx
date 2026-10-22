import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { RadioButton } from 'react-native-paper';
import * as Crypto from 'expo-crypto';
import * as DocumentPicker from 'expo-document-picker';
import { File, Paths } from 'expo-file-system';
import { accountOwner, request } from './api';
import { formatMoney, integer } from './accounting';
import { getDatabase } from './native';
import { saveGroup } from './storage';
import { readPendingSplitwiseImport, retrySplitwiseImport, startSplitwiseImport } from './splitwiseImport';
import type { SplitwiseImportRequest, SplitwisePreview } from './splitwiseImport';
import type { Group, Session } from './types';
import { Button, useUI } from './ui';

export type SplitwiseImportScreenProps = {
  session: Session; busy: boolean; onBusyChange: (busy: boolean) => void;
  onImported: (group: Group, alreadyImported: boolean) => void; onCancel: () => void;
};
const MAX_FILE_BYTES = 1_048_576;
const balanceText = (value: string) => integer(value, true) > 0n ? `Is owed ${formatMoney(value)}`
  : integer(value, true) < 0n ? `Owes ${formatMoney((-integer(value, true)).toString())}` : 'Settled up';

export default function SplitwiseImportScreen({ session, busy, onBusyChange, onImported, onCancel }: SplitwiseImportScreenProps) {
  const { palette: colors, ui, inputColors } = useUI();
  const [checking, setChecking] = useState(true), [working, setWorking] = useState(false), [error, setError] = useState('');
  const [preview, setPreview] = useState<SplitwisePreview | null>(null), [csv, setCsv] = useState(''), [filename, setFilename] = useState('');
  const [name, setName] = useState(''), [selfIndex, setSelfIndex] = useState<number | null>(null), [payers, setPayers] = useState<Record<string, number>>({});
  const [pending, setPending] = useState<SplitwiseImportRequest | null>(null);
  const lock = useRef(false), mounted = useRef(true), activeOwner = useRef(accountOwner(session));
  const scope = accountOwner(session); activeOwner.current = scope;
  const current = () => mounted.current && activeOwner.current === scope;
  const disabled = busy || checking || working;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    let active = true; setChecking(true); setError('');
    void getDatabase().then(db => readPendingSplitwiseImport(db, session)).then(saved => { if (active) setPending(saved); })
      .catch(cause => { if (active) setError(cause instanceof Error ? cause.message : 'Could not read your saved import.'); })
      .finally(() => { if (active) setChecking(false); });
    return () => { active = false; };
  }, [scope]);

  async function run(action: () => Promise<void>) {
    if (lock.current || busy || checking) return;
    lock.current = true; setWorking(true); setError(''); onBusyChange(true);
    try { await action(); }
    catch (cause) { if (current()) setError(cause instanceof Error ? cause.message : 'Could not import this file. Try again.'); }
    finally { lock.current = false; if (current()) setWorking(false); onBusyChange(false); }
  }
  async function pickFile() {
    const result = await DocumentPicker.getDocumentAsync({ type: '*/*', multiple: false, copyToCacheDirectory: true });
    if (result.canceled) return;
    const asset = result.assets[0], file = new File(asset.uri);
    try {
      if (!current()) return;
      setPreview(null); setCsv(''); setFilename(''); setSelfIndex(null); setPayers({});
      if (!asset.name.toLowerCase().endsWith('.csv')) throw new Error('Choose the CSV export from a Splitwise group.');
      if ((asset.size ?? file.size) > MAX_FILE_BYTES) throw new Error('Choose a CSV file up to 1 MB.');
      const contents = await file.text();
      const resultPreview = await request<SplitwisePreview>(session, '/imports/splitwise/preview', 'POST', { csv: contents });
      if (!current()) return;
      setCsv(contents); setPreview(resultPreview); setFilename(asset.name); setSelfIndex(null); setPayers({});
      setName(asset.name.replace(/\.csv$/i, '').slice(0, 100));
    } finally {
      // Only remove the picker copy in our cache, never the user's source file.
      try { if (file.uri.startsWith(`${Paths.cache.uri.replace(/\/$/, '')}/`) && file.exists) file.delete(); }
      catch { /* A cache cleanup failure must not turn a valid preview into an error. */ }
    }
  }
  async function finishImport() {
    const db = await getDatabase();
    if (!pending) {
      if (!preview || !name.trim() || selfIndex === null) throw new Error('Name the group and choose which person is you.');
      if (preview.unresolved.some(row => payers[String(row.row)] === undefined)) throw new Error('Choose who paid each bill that needs review.');
      const body: SplitwiseImportRequest = { command_id: Crypto.randomUUID(), id: Crypto.randomUUID(), csv, name: name.trim(), self_index: selfIndex, payers };
      await startSplitwiseImport(db, session, body);
      if (current()) setPending(body);
    }
    const result = await retrySplitwiseImport(db, session);
    if (current()) onImported(result.group, result.alreadyImported);
  }
  async function openExisting() {
    if (!preview?.duplicate_group) return;
    const group = await request<Group>(session, `/groups/${preview.duplicate_group.id}`);
    await saveGroup(await getDatabase(), scope, group, 'shared');
    if (current()) onImported(group, true);
  }
  return <View style={styles.form}>
    {checking ? <Text style={ui.caption}>Checking for a saved import…</Text> : pending ? <>
      <Text style={ui.section}>{pending.name}</Text>
      <Text style={ui.notice}>This import was saved before sending. Retry to finish or recover it. The same file and choices will be used, so it won't create another copy.</Text>
      <Button title={working ? 'Finishing import…' : 'Retry saved import'} kind="primary" disabled={disabled} onPress={() => void run(finishImport)} />
      <Button title="Close for now" kind="text" disabled={disabled} onPress={onCancel} />
    </> : <>
      <Text style={ui.caption}>Bring a Splitwise group CSV into a new shared group. INR exports up to 1 MB are supported. You need an internet connection.</Text>
      <Button title={preview ? 'Choose another CSV' : 'Choose CSV file'} disabled={disabled} onPress={() => void run(pickFile)} />
      {preview && <>
        <Text style={ui.label}>{filename}</Text>
        <Text style={ui.section}>{preview.expense_count} bills · {preview.payment_count} payments</Text>
        <Text style={ui.caption}>{preview.members.length} people · {preview.currency}</Text>
        {preview.duplicate_group ? <>
          <Text style={ui.notice}>This file was already imported as {preview.duplicate_group.name}.</Text>
          <Button title="Open existing group" kind="primary" disabled={disabled} onPress={() => void run(openExisting)} />
        </> : <>
          <View style={styles.field}><Text style={ui.label}>New group name</Text><TextInput {...inputColors} accessibilityLabel="New group name" value={name} onChangeText={setName} maxLength={100} editable={!disabled} style={ui.input} /></View>
          <Text style={ui.section}>Which person are you?</Text>
          {preview.members.map((member, index) => <View key={index} style={[styles.person, { borderBottomColor: colors.line }]}>
            <RadioButton.Item label={member} value={String(index)} status={selfIndex === index ? 'checked' : 'unchecked'} onPress={() => setSelfIndex(index)} disabled={disabled} mode="android" labelStyle={ui.body} accessibilityLabel={`I am ${member}`} />
            <Text style={[ui.caption, styles.balance]}>{balanceText(preview.balances[index])}</Text>
          </View>)}
          {preview.unresolved.map(row => <View key={row.row} style={[styles.review, { borderColor: colors.line }]}>
            <Text style={ui.section}>Who paid {formatMoney(row.amount)}?</Text>
            <Text style={ui.body}>{row.description}</Text><Text style={ui.caption}>{row.date} · {row.category} · CSV row {row.row}</Text>
            <Text style={ui.caption}>This bill has no balance change. Choose who paid and used it. No one will owe anything for this bill.</Text>
            {preview.members.map((member, index) => <RadioButton.Item key={index} label={member} value={String(index)} status={payers[String(row.row)] === index ? 'checked' : 'unchecked'}
              onPress={() => setPayers(values => ({ ...values, [String(row.row)]: index }))} disabled={disabled} mode="android" labelStyle={ui.body} accessibilityLabel={`${member} paid CSV row ${row.row}`} />)}
          </View>)}
          <Text style={ui.caption}>The export shows net amounts, so original payer and split details may be incomplete. Check the balances before importing. Recorded payments do not send money.</Text>
          {preview.warnings.map((warning, index) => <Text key={index} style={ui.notice}>{warning}</Text>)}
          <Button title={working ? 'Importing…' : 'Confirm import'} kind="primary" disabled={disabled || !name.trim() || selfIndex === null || preview.unresolved.some(row => payers[String(row.row)] === undefined)} onPress={() => void run(finishImport)} />
        </>}
      </>}
    </>}
    {!!error && <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={ui.error}>{error}</Text>}
  </View>;
}
const styles = StyleSheet.create({
  form: { gap: 12 }, field: { gap: 7 }, person: { borderBottomWidth: StyleSheet.hairlineWidth, paddingBottom: 8 },
  balance: { paddingHorizontal: 16 }, review: { gap: 10, borderWidth: 1, borderRadius: 8, padding: 12 },
});
