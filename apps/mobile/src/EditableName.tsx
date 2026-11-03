import React, { useRef, useState } from 'react';
import { Keyboard, StyleSheet, useWindowDimensions } from 'react-native';
import { Text } from 'react-native-paper';
import * as Crypto from 'expo-crypto';
import FieldDialog from './FieldDialog';
import { TextField } from './FormFields';
import { Button, Icon, useUI } from './ui';

export default function EditableName({ name, displayName = name, title, label, path, version, busy, editable, onAction, textStyle, allowEmpty = false }: {
  name: string; displayName?: string; title: string; label: string; path: string; version: number; busy: boolean; editable: boolean;
  onAction: (path: string, body: Record<string, unknown>) => Promise<Record<string, unknown>>;
  textStyle?: React.ComponentProps<typeof Text>['style']; allowEmpty?: boolean;
}) {
  const { ui } = useUI(), [open, setOpen] = useState(false), [value, setValue] = useState(name), [error, setError] = useState(''), [saving, setSaving] = useState(false);
  const pending = useRef<{ command_id: string; version: number; name: string } | null>(null), inFlight = useRef(false), initial = useRef(name), openedVersion = useRef(version);
  const { fontScale } = useWindowDimensions();
  const lineHeight = StyleSheet.flatten([ui.rowTitle, textStyle])?.lineHeight ?? 23;
  // Keep the 44pt tap area without reserving its unused lower inset above the subtitle.
  const bottomInset = Math.max(0, (44 - lineHeight * fontScale) / 2);
  const disabled = busy || saving || !editable;
  function close() { Keyboard.dismiss(); setOpen(false); }
  async function save() {
    const trimmed = value.trim();
    if (inFlight.current || disabled || (!allowEmpty && !trimmed) || trimmed === initial.current) return;
    if (pending.current?.name !== trimmed) pending.current = { command_id: Crypto.randomUUID(), version: openedVersion.current, name: trimmed };
    inFlight.current = true; setSaving(true); setError('');
    try { await onAction(path, pending.current); pending.current = null; close(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save the name. Try again.'); }
    finally { inFlight.current = false; setSaving(false); }
  }
  return <>
    {editable ? <Button kind="plain" accessibilityLabel={label} disabled={disabled} onPress={() => { initial.current = name; openedVersion.current = version; setValue(name); setError(''); setOpen(true); }} style={{ flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', minHeight: 44, marginBottom: -bottomInset, zIndex: 1, gap: 8, maxWidth: '100%' }}>
      <Text style={[ui.rowTitle, textStyle, { flexShrink: 1 }]} numberOfLines={1}>{displayName}</Text><Icon name="edit" size={16} />
    </Button> : <Text style={[ui.rowTitle, textStyle]} numberOfLines={1}>{displayName}</Text>}
    <FieldDialog visible={open} title={title} disabled={busy || saving} canSave={editable && (allowEmpty || !!value.trim()) && value.trim() !== initial.current} saveLabel={saving ? 'Saving…' : 'Save'} onClose={close} onSave={() => void save()} error={error}>
      <TextField label={title} value={value} onChangeText={setValue} editable={!disabled} autoFocus maxLength={120} autoCapitalize="words" onSubmitEditing={() => void save()} />
      {allowEmpty && <Text style={ui.caption}>Only in this group. Leave empty to use their original name.</Text>}
    </FieldDialog>
  </>;
}
