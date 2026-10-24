import React, { useEffect, useRef, useState } from 'react';
import { Dialog } from 'react-native-paper';
import KeyboardDialog from './KeyboardDialog';
import DialogFocus from './DialogFocus';
import { DialogScrollBody } from './DialogParts';
import { TextField } from './FormFields';
import { Button, ErrorText } from './ui';
import { validUPIAddress } from './upi';
import { NameOnlyForm } from './EmailLinkScreens';

export default function UPISetupDialog({ visible, busy, needsName, onSaveName, onSave, onSkip }: {
  visible: boolean; busy: boolean; needsName: boolean; onSaveName: (name: string) => Promise<void>; onSave: (vpa: string) => Promise<void>; onSkip: () => void;
}) {
  const [vpa, setVpa] = useState(''), [saving, setSaving] = useState(false), [error, setError] = useState('');
  const lock = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const disabled = busy || saving;
  function skip() { if (!needsName && !busy && !lock.current) onSkip(); }
  async function save() {
    if (busy || lock.current || !validUPIAddress(vpa.trim())) return;
    lock.current = true; setSaving(true); setError('');
    try { await onSave(vpa.trim()); if (mounted.current) onSkip(); }
    catch { if (mounted.current) setError('Could not save your UPI ID. Try again.'); }
    finally { lock.current = false; if (mounted.current) setSaving(false); }
  }
  return <KeyboardDialog visible={visible} dismissable={!disabled && !needsName} onDismiss={skip}>
    <DialogFocus active={visible} busy={disabled} onEscape={skip}>
      <Dialog.Title aria-level={2}>{needsName ? 'Your name' : 'Your UPI ID'}</Dialog.Title>
      <DialogScrollBody maxHeight={280} gap={12}>
        {needsName ? <NameOnlyForm busy={disabled} onSave={onSaveName} /> : <TextField label="UPI ID (optional)" placeholder="name@bank" value={vpa} onChangeText={setVpa} autoCapitalize="none" autoCorrect={false} keyboardType="email-address" maxLength={254} editable={!disabled} />}
        {!!error && <ErrorText live>{error}</ErrorText>}
      </DialogScrollBody>
      {!needsName && <Dialog.Actions><Button title="Skip" kind="text" disabled={disabled} onPress={skip} /><Button title={saving ? 'Saving' : 'Save'} kind="primary" disabled={disabled || !validUPIAddress(vpa.trim())} onPress={() => void save()} /></Dialog.Actions>}
    </DialogFocus>
  </KeyboardDialog>;
}
