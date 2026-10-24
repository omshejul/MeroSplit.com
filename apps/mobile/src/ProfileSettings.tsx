import { CancelDialogActions } from './DialogParts';
import KeyboardDialog from './KeyboardDialog';
import React, { useEffect, useRef, useState } from 'react';
import { Keyboard, Platform, ScrollView, TextInput, View } from 'react-native';
import { Dialog, Text } from 'react-native-paper';
import { RadioChoice } from './FormFields';
import { Button, ErrorText, SettingsRow, useUI, type AppearancePreference } from './ui';

export default function ProfileSettings({ name, vpa, busy, onSaveName, onSaveUPI, onAppearance }: {
  name: string; vpa: string; busy: boolean; onSaveName: (name: string) => Promise<void>; onSaveUPI: (vpa: string) => Promise<void>; onAppearance: (value: AppearancePreference) => Promise<void>;
}) {
  const { ui, inputColors, appearance } = useUI();
  const [editing, setEditing] = useState<'name' | 'upi' | 'appearance' | null>(null), [draft, setDraft] = useState(''), [error, setError] = useState(''), [saving, setSaving] = useState(false);
  const nameRow = useRef<React.ComponentRef<typeof View>>(null), upiRow = useRef<React.ComponentRef<typeof View>>(null), appearanceRow = useRef<React.ComponentRef<typeof View>>(null), input = useRef<React.ComponentRef<typeof TextInput>>(null), inFlight = useRef(false);
  const disabled = busy || saving, isName = editing === 'name', isAppearance = editing === 'appearance';
  const valid = isName ? !!draft.trim() : /^[A-Za-z0-9._-]{2,}@[A-Za-z0-9.-]{2,}$/.test(draft.trim()) && draft.trim().length <= 254;
  function open(field: NonNullable<typeof editing>) { setDraft(field === 'name' ? name : vpa); setError(''); setEditing(field); }
  function close() { const row = isName ? nameRow : isAppearance ? appearanceRow : upiRow; Keyboard.dismiss(); setEditing(null); setError(''); requestAnimationFrame(() => row.current?.focus()); }
  useEffect(() => {
    if (Platform.OS !== 'web' || !editing) return;
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !disabled) { event.preventDefault(); event.stopPropagation(); close(); } };
    document.addEventListener('keydown', escape, true);
    return () => document.removeEventListener('keydown', escape, true);
  }, [editing, disabled]);
  async function save(choice?: AppearancePreference) {
    if (disabled || inFlight.current) return;
    if (!isAppearance && !valid) { setError(isName ? 'Enter a name.' : 'Enter a valid UPI ID.'); return; }
    inFlight.current = true; setSaving(true); setError('');
    try { if (choice) await onAppearance(choice); else if (isName) await onSaveName(draft.trim()); else await onSaveUPI(draft.trim()); close(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save. Try again.'); requestAnimationFrame(() => input.current?.focus()); }
    finally { inFlight.current = false; setSaving(false); }
  }
  return <>
    <SettingsRow rowRef={nameRow} icon="edit" label="Name" value={name} disabled={busy} onPress={() => open('name')} />
    <SettingsRow rowRef={upiRow} icon="pay" label="UPI ID" value={vpa || 'Not set'} disabled={busy} onPress={() => open('upi')} />
    <SettingsRow rowRef={appearanceRow} icon="appearance" label="Appearance" value={appearance[0].toUpperCase() + appearance.slice(1)} disabled={busy} onPress={() => open('appearance')} />
    <KeyboardDialog visible={!!editing} onDismiss={() => { if (!disabled) close(); }} dismissable={!disabled}>
      <Dialog.Title aria-level={2}>{isAppearance ? 'Appearance' : isName ? 'Name' : 'UPI ID'}</Dialog.Title>
      <Dialog.Content style={{ flexShrink: 1 }}><ScrollView keyboardShouldPersistTaps="handled">
        {isAppearance ? (['system', 'light', 'dark'] as const).map(value => <RadioChoice key={value} value={value} label={value[0].toUpperCase() + value.slice(1)} selected={appearance === value} disabled={disabled} onPress={() => void save(value)} />)
          : <View style={{ gap: 8 }}><TextInput ref={input} {...inputColors} autoFocus accessibilityLabel={isName ? 'Name' : 'UPI ID'} value={draft} maxLength={isName ? 120 : 254} autoCorrect={false} autoCapitalize={isName ? 'words' : 'none'} autoComplete={isName ? 'name' : 'off'} keyboardType={isName ? 'default' : 'email-address'} returnKeyType="done" editable={!disabled} style={ui.input}
            onChangeText={text => { setDraft(text); setError(''); }} onSubmitEditing={() => void save()} onKeyPress={event => { if (event.nativeEvent.key === 'Escape' && !disabled) close(); }} />
            {!isName && <Text style={ui.caption}>Check this address. It is not bank verified.</Text>}</View>}
        {!!error && <ErrorText live>{error}</ErrorText>}
      </ScrollView></Dialog.Content>
      <CancelDialogActions disabled={disabled} onCancel={close}>{!isAppearance && <Button title={saving ? 'Saving…' : 'Save'} disabled={disabled || !valid || draft.trim() === (isName ? name : vpa)} onPress={() => void save()} />}</CancelDialogActions>
    </KeyboardDialog>
  </>;
}
