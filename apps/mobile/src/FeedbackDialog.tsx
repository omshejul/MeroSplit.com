import { Dialog } from './DialogParts';
import React, { useEffect, useRef, useState } from 'react';
import * as Crypto from 'expo-crypto';
import KeyboardDialog from './KeyboardDialog';
import DialogFocus from './DialogFocus';
import { CancelDialogActions, DialogScrollBody } from './DialogParts';
import { TextField } from './FormFields';
import { Button, ErrorText } from './ui';
import { useToast } from './Toast';

export type FeedbackSubmission = { id: string; text: string };

export default function FeedbackDialog({ visible, onClose, onSubmit }: {
  visible: boolean; onClose: () => void; onSubmit: (body: FeedbackSubmission) => Promise<void>;
}) {
  const notify = useToast();
  const [text, setText] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(''), [sent, setSent] = useState(false);
  const pending = useRef<FeedbackSubmission | null>(null), lock = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  function close() {
    if (lock.current) return;
    if (sent) { pending.current = null; setText(''); setSent(false); }
    onClose();
  }
  async function submit() {
    if (lock.current || sent || !text.trim()) return;
    lock.current = true; setBusy(true); setError('');
    pending.current ??= { id: Crypto.randomUUID(), text: text.trim() };
    try { await onSubmit(pending.current); if (mounted.current) { setSent(true); notify('Feedback sent.'); } }
    catch { if (mounted.current) setError('Could not confirm it was sent. Submit again to retry this message.'); }
    finally { lock.current = false; if (mounted.current) setBusy(false); }
  }
  return <KeyboardDialog visible={visible} dismissable={!busy} onDismiss={close}>

      <Dialog.Title aria-level={2}>Feedback</Dialog.Title>
      <DialogScrollBody maxHeight={320} gap={12}>
        <>
          <TextField label="Your feedback" value={text} onChangeText={setText} multiline maxLength={2000} editable={!sent && !busy && !pending.current} style={{ minHeight: 120, textAlignVertical: 'top' }} />
          {!!error && <ErrorText live>{error}</ErrorText>}
        </>
      </DialogScrollBody>
      <CancelDialogActions cancelTitle={sent ? 'Close feedback' : 'Cancel'} disabled={busy} onCancel={close}>
        <Button title={sent ? 'Sent' : busy ? 'Sending' : 'Send feedback'} icon={sent ? 'check' : 'feedback'} kind="primary" disabled={sent || busy || !text.trim()} onPress={() => void submit()} />
      </CancelDialogActions>

  </KeyboardDialog>;
}
