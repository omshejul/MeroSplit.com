import { LoadingState } from './UIStates';
import { NoticeBanner } from './UIStates';
import { ErrorText } from './ui';
import PersonChoice from './PersonChoice';
import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
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
import { TextField } from './FormFields';

export type SplitwiseImportScreenProps = {
  session: Session; busy: boolean; onBusyChange: (busy: boolean) => void;
  onImported: (group: Group, alreadyImported: boolean) => void; onCancel: () => void;
};
const balanceText = (value: string) => integer(value, true) > 0n ? `Is owed ${formatMoney(value)}`
  : integer(value, true) < 0n ? `Owes ${formatMoney((-integer(value, true)).toString())}` : 'Settled up';

function ImportChoice({ member, index, selected, disabled, label, onSelect }: {
  member: string; index: number; selected: boolean; disabled: boolean; label: string; onSelect: (index: number) => void;
}) {
  return <PersonChoice person={{ name: member }} title={member} accessibilityLabel={label} selected={selected} role="radio" disabled={disabled} onPress={() => onSelect(index)} />;
}

function ImportIdentity({ members, balances, selected, disabled, onSelect }: {
  members: string[]; balances: string[]; selected: number | null; disabled: boolean; onSelect: (index: number) => void;
}) {
  const { palette, ui } = useUI();
  return <>
    <Text style={ui.section}>Which person are you?</Text>
    {members.map((member, index) => <View key={index} style={[styles.person, { borderBottomColor: palette.line }]}>
      <ImportChoice member={member} index={index} selected={selected === index} disabled={disabled} onSelect={onSelect} label={`I am ${member}`} />
      <Text style={[ui.caption, styles.balance]}>{balanceText(balances[index])}</Text>
    </View>)}
  </>;
}

function ImportPayer({ row, members, selected, disabled, onSelect }: {
  row: SplitwisePreview['unresolved'][number]; members: string[]; selected: number | undefined; disabled: boolean; onSelect: (index: number) => void;
}) {
  const { palette, ui } = useUI();
  return <View style={[styles.review, { borderColor: palette.line }]}>
    <Text style={ui.section}>Who paid {formatMoney(row.amount)}?</Text>
    <Text style={ui.body}>{row.description}</Text><Text style={ui.caption}>{new Date(`${row.date}T12:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}</Text>
    <Text style={ui.caption}>Choose who paid and used this bill. Balances stay unchanged.</Text>
    {members.map((member, index) => <ImportChoice key={index} member={member} index={index} selected={selected === index} disabled={disabled}
      onSelect={onSelect} label={`${member} paid CSV row ${row.row}`} />)}
  </View>;
}

export default function SplitwiseImportScreen({ session, busy, onBusyChange, onImported, onCancel }: SplitwiseImportScreenProps) {
  const { ui } = useUI();
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
    {checking ? <LoadingState label="Checking for a saved import…" /> : pending ? <>
      <Text style={ui.section}>{pending.name}</Text>
      <NoticeBanner tone="warning">Import not confirmed. Your file and choices are saved.</NoticeBanner>
      <Button title={working ? 'Finishing import…' : 'Retry saved import'} kind="primary" disabled={disabled} onPress={() => void run(finishImport)} />
      <Button title="Close for now" kind="text" disabled={disabled} onPress={onCancel} />
    </> : <>
      {!preview && <Button title="Choose CSV file" kind="primary" disabled={disabled} onPress={() => void run(pickFile)} />}
      {preview && <>
        <Text style={ui.caption}>{preview.expense_count} bills · {preview.payment_count} payments · {preview.members.length} people · {preview.currency}</Text>
        {preview.duplicate_group ? <>
          <NoticeBanner>This file was already imported as {preview.duplicate_group.name}.</NoticeBanner>
          <Button title="Open existing group" kind="primary" disabled={disabled} onPress={() => void run(openExisting)} />
        </> : <>
          <TextField label="Group name" value={name} onChangeText={setName} maxLength={100} editable={!disabled} />
          <ImportIdentity members={preview.members} balances={preview.balances} selected={selfIndex} disabled={disabled} onSelect={setSelfIndex} />
          {preview.unresolved.map(row => <ImportPayer key={row.row} row={row} members={preview.members} selected={payers[String(row.row)]} disabled={disabled}
            onSelect={index => setPayers(values => ({ ...values, [String(row.row)]: index }))} />)}
          {preview.warnings.map((warning, index) => <Text key={index} style={[ui.notice, ui.warning]}>{warning}</Text>)}
          <Button title={working ? 'Importing…' : 'Import'} kind="primary" disabled={disabled || !name.trim() || selfIndex === null || preview.unresolved.some(row => payers[String(row.row)] === undefined)} onPress={() => void run(finishImport)} />
        </>}
        <Button title="Choose another CSV" kind="text" disabled={disabled} onPress={() => void run(pickFile)} />
      </>}
    </>}
    {!!error && <ErrorText live>{error}</ErrorText>}
  </View>;
}
const styles = StyleSheet.create({
  form: { gap: 12 }, person: { borderBottomWidth: StyleSheet.hairlineWidth, paddingBottom: 8 },
  balance: { paddingHorizontal: 16 }, review: { gap: 10, borderWidth: 1, borderRadius: radii.surface, padding: 12 },
});
