import React, { useEffect, useRef, useState } from 'react';
import { Animated, View } from 'react-native';
import { Dialog, Text } from 'react-native-paper';
import * as Crypto from 'expo-crypto';
import KeyboardDialog from './KeyboardDialog';
import DialogFocus from './DialogFocus';
import { CancelDialogActions, DialogScrollBody } from './DialogParts';
import { TextField } from './FormFields';
import { Button, ErrorText, useUI } from './ui';
import { useMotionValue } from './motion';

export type FeedbackSubmission = { id: string; text: string };

function FeedbackThanks({ onClose }: { onClose: () => void }) {
  const { ui, motion } = useUI(), [shown, setShown] = useState(false);
  const progress = useMotionValue(shown ? 1 : 0, motion.enabled);
  useEffect(() => { setShown(true); }, []);
  return <View style={{ alignItems: 'center', gap: 8 }}>
    <Animated.View style={{ opacity: progress, transform: [{ scale: progress.interpolate({ inputRange: [0, 1], outputRange: [0.8, 1] }) }] }}>
      <Button title="Done" icon="thumbsUp" kind="text" accessibilityLabel="Feedback submitted. Close" onPress={onClose} />
    </Animated.View>
    <Text accessibilityLiveRegion="polite" style={ui.body}>Thanks!</Text>
  </View>;
}

export default function FeedbackDialog({ visible, onClose, onSubmit }: {
  visible: boolean; onClose: () => void; onSubmit: (body: FeedbackSubmission) => Promise<void>;
}) {
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
    try { await onSubmit(pending.current); if (mounted.current) setSent(true); }
    catch { if (mounted.current) setError('Could not confirm it was sent. Submit again to retry this message.'); }
    finally { lock.current = false; if (mounted.current) setBusy(false); }
  }
  return <KeyboardDialog visible={visible} dismissable={!busy} onDismiss={close}>
    <DialogFocus active={visible} busy={busy} onEscape={close}>
      <Dialog.Title aria-level={2}>Feedback</Dialog.Title>
      <DialogScrollBody maxHeight={320} gap={12}>
        {sent ? <FeedbackThanks onClose={close} /> : <>
          <TextField label="Your feedback" value={text} onChangeText={setText} multiline maxLength={2000} editable={!busy && !pending.current} style={{ minHeight: 120, textAlignVertical: 'top' }} />
          {!!error && <ErrorText live>{error}</ErrorText>}
        </>}
      </DialogScrollBody>
      {!sent && <CancelDialogActions disabled={busy} onCancel={close}>
        <Button title={busy ? 'Submitting' : 'Submit'} kind="primary" disabled={busy || !text.trim()} onPress={() => void submit()} />
      </CancelDialogActions>}
    </DialogFocus>
  </KeyboardDialog>;
}
