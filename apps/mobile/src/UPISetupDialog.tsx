import { Dialog } from './DialogParts';
import { Text } from 'react-native-paper';
import React, { useEffect, useRef, useState } from 'react';

import KeyboardDialog from './KeyboardDialog';
import DialogFocus from './DialogFocus';
import { DialogScrollBody } from './DialogParts';
import { UPIAddressField } from './FormFields';
import { Button, ErrorText, useUI } from './ui';
import { validUPIAddress } from './upi';
import { NameOnlyForm } from './EmailLinkScreens';

export default function UPISetupDialog({ visible, busy, needsName, afterFirstSplit = false, onSaveName, onSave, onSkip }: {
  visible: boolean; busy: boolean; needsName: boolean; afterFirstSplit?: boolean; onSaveName: (name: string) => Promise<void>; onSave: (vpa: string) => Promise<void>; onSkip: () => void;
}) {
  const { ui } = useUI();
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

      <Dialog.Title aria-level={2}>{needsName ? 'Your name' : afterFirstSplit ? 'Your money needs directions.' : 'Your UPI ID'}</Dialog.Title>
      <DialogScrollBody maxHeight={280} gap={12}>
        {!needsName && afterFirstSplit && <Text style={ui.body}>Add your UPI ID so friends can pay you without the "UPI bhej na."</Text>}
        {needsName ? <NameOnlyForm busy={disabled} onSave={onSaveName} /> : <UPIAddressField label="UPI ID (optional)" placeholder="name@bank" value={vpa} onChangeText={setVpa} autoCapitalize="none" autoCorrect={false} keyboardType="email-address" maxLength={254} editable={!disabled} />}
        {!!error && <ErrorText live>{error}</ErrorText>}
      </DialogScrollBody>
      {!needsName && <Dialog.Actions><Button title={afterFirstSplit ? 'Set up later' : 'Skip UPI setup'} kind="text" disabled={disabled} onPress={skip} /><Button title={saving ? 'Saving UPI ID…' : afterFirstSplit ? 'Add UPI ID' : 'Save UPI ID'} kind="primary" disabled={disabled || !validUPIAddress(vpa.trim())} onPress={() => void save()} /></Dialog.Actions>}

  </KeyboardDialog>;
}
