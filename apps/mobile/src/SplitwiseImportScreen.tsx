import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { RadioButton } from 'react-native-paper';
import * as Crypto from 'expo-crypto';
import { pickSplitwiseCsv } from './csvFile';
import { accountOwner, request } from './api';
import { formatMoney, integer } from './accounting';
import { getDatabase } from './native';
import { saveGroup } from './storage';
import { readPendingSplitwiseImport, retrySplitwiseImport, startSplitwiseImport } from './splitwiseImport';
import type { SplitwiseImportRequest, SplitwisePreview } from './splitwiseImport';
import type { Group, Session } from './types';
import { Button, radii, useUI } from './ui';

export type SplitwiseImportScreenProps = {
  session: Session; busy: boolean; onBusyChange: (busy: boolean) => void;
  onImported: (group: Group, alreadyImported: boolean) => void; onCancel: () => void;
};
const balanceText = (value: string) => integer(value, true) > 0n ? `Is owed ${formatMoney(value)}`
  : integer(value, true) < 0n ? `Owes ${formatMoney((-integer(value, true)).toString())}` : 'Settled up';

export default function SplitwiseImportScreen({ session, busy, onBusyChange, onImported, onCancel }: SplitwiseImportScreenProps) {
  const { palette: colors, ui, inputColors } = useUI();
  const [checking, setChecking] = useState(true), [working, setWorking] = useState(false), [error, setError] = useState('');
  const [preview, setPreview] = useState<SplitwisePreview | null>(null), [csv, setCsv] = useState('');
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
    const file = await pickSplitwiseCsv(); if (!file || !current()) return;
    setPreview(null); setCsv(''); setSelfIndex(null); setPayers({});
    const resultPreview = await request<SplitwisePreview>(session, '/imports/splitwise/preview', 'POST', { csv: file.contents });
    if (!current()) return;
    setCsv(file.contents); setPreview(resultPreview); setSelfIndex(null); setPayers({});
    setName(file.name.replace(/\.csv$/i, '').replace(/[_-]+/g, ' ').trim().slice(0, 100));
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
    const group = await request<Group>(session, `/groups/${preview.duplicate_group.id}/summary`);
    await saveGroup(await getDatabase(), scope, group, 'shared');
    if (current()) onImported(group, true);
  }
  return <View style={styles.form}>
    {checking ? <Text style={ui.caption}>Checking for a saved import…</Text> : pending ? <>
      <Text style={ui.section}>{pending.name}</Text>
      <Text style={[ui.notice, ui.warning]}>Import not confirmed. Retry safely with the same file and choices.</Text>
      <Button title={working ? 'Finishing import…' : 'Retry saved import'} kind="primary" disabled={disabled} onPress={() => void run(finishImport)} />
      <Button title="Close for now" kind="text" disabled={disabled} onPress={onCancel} />
    </> : <>
      <Button title={preview ? 'Choose another CSV' : 'Choose CSV file'} disabled={disabled} onPress={() => void run(pickFile)} />
      {preview && <>
        <Text style={ui.section}>{preview.expense_count} bills · {preview.payment_count} payments</Text>
        <Text style={ui.caption}>{preview.members.length} people · {preview.currency}</Text>
        {preview.duplicate_group ? <>
          <Text style={ui.notice}>This file was already imported as {preview.duplicate_group.name}.</Text>
          <Button title="Open existing group" kind="primary" disabled={disabled} onPress={() => void run(openExisting)} />
        </> : <>
          <View style={styles.field}><Text style={ui.label}>Group name</Text><TextInput {...inputColors} accessibilityLabel="Group name" value={name} onChangeText={setName} maxLength={100} editable={!disabled} style={ui.input} /></View>
          <Text style={ui.section}>Which person are you?</Text>
          {preview.members.map((member, index) => <View key={index} style={[styles.person, { borderBottomColor: colors.line }]}>
            <RadioButton.Item label={member} value={String(index)} status={selfIndex === index ? 'checked' : 'unchecked'} onPress={() => setSelfIndex(index)} disabled={disabled} mode="android" labelStyle={ui.body} accessibilityLabel={`I am ${member}`} />
            <Text style={[ui.caption, styles.balance]}>{balanceText(preview.balances[index])}</Text>
          </View>)}
          {preview.unresolved.map(row => <View key={row.row} style={[styles.review, { borderColor: colors.line }]}>
            <Text style={ui.section}>Who paid {formatMoney(row.amount)}?</Text>
            <Text style={ui.body}>{row.description}</Text><Text style={ui.caption}>{new Date(`${row.date}T12:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}</Text>
            <Text style={ui.caption}>Choose who paid and used this bill. Balances stay unchanged.</Text>
            {preview.members.map((member, index) => <RadioButton.Item key={index} label={member} value={String(index)} status={payers[String(row.row)] === index ? 'checked' : 'unchecked'}
              onPress={() => setPayers(values => ({ ...values, [String(row.row)]: index }))} disabled={disabled} mode="android" labelStyle={ui.body} accessibilityLabel={`${member} paid CSV row ${row.row}`} />)}
          </View>)}
          <Text style={ui.caption}>Check the balances. Original payer and split details may be incomplete; no money is sent.</Text>
          {preview.warnings.map((warning, index) => <Text key={index} style={[ui.notice, ui.warning]}>{warning}</Text>)}
          <Button title={working ? 'Importing…' : 'Import'} kind="primary" disabled={disabled || !name.trim() || selfIndex === null || preview.unresolved.some(row => payers[String(row.row)] === undefined)} onPress={() => void run(finishImport)} />
        </>}
      </>}
    </>}
    {!!error && <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={ui.error}>{error}</Text>}
  </View>;
}
const styles = StyleSheet.create({
  form: { gap: 12 }, field: { gap: 7 }, person: { borderBottomWidth: StyleSheet.hairlineWidth, paddingBottom: 8 },
  balance: { paddingHorizontal: 16 }, review: { gap: 10, borderWidth: 1, borderRadius: radii.surface, padding: 12 },
});
