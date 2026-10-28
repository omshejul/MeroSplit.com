import React from 'react';
import KeyboardDialog from './KeyboardDialog';
import { Dialog, DialogScrollBody, CancelDialogActions } from './DialogParts';
import { Button, ErrorText } from './ui';
export default function FieldDialog({ title, visible, disabled, canSave, saveLabel = 'Save', onClose, onSave, error, children, maxHeight = 280 }: {
  title: string; visible: boolean; disabled: boolean; canSave: boolean; saveLabel?: string; onClose: () => void; onSave: () => void; error?: string; children: React.ReactNode; maxHeight?: number;
}) {
  return <KeyboardDialog visible={visible} dismissable={!disabled} onDismiss={() => { if (!disabled) onClose(); }}>
    <Dialog.Title>{title}</Dialog.Title><DialogScrollBody maxHeight={maxHeight} gap={8}>{children}{!!error && <ErrorText live>{error}</ErrorText>}</DialogScrollBody>
    <CancelDialogActions disabled={disabled} onCancel={onClose}><Button title={saveLabel} kind="primary" disabled={disabled || !canSave} onPress={onSave} /></CancelDialogActions>
  </KeyboardDialog>;
}
