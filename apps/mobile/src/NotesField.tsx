import React, { useRef, useState } from 'react';
import { View } from 'react-native';
import { Text } from 'react-native-paper';
import KeyboardDialog from './KeyboardDialog';
import { CloseDialogActions, Dialog, DialogScrollBody } from './DialogParts';
import MarkdownNotes from './MarkdownNotes';
import { Button, useUI } from './ui';
import { TextField } from './FormFields';

const example = '**Bold**, *italic*, ~~strikethrough~~ and `code`\n\n# Heading\n\n- List item\n- [x] Completed task\n\n[Link](https://example.com)\n\n| Item | Amount |\n| --- | ---: |\n| Dinner | ₹500 |\n| Taxi | ₹200 |';

export default function NotesField({ value, disabled, onChange }: { value: string; disabled: boolean; onChange: (value: string) => void }) {
  const { ui } = useUI(), [preview, setPreview] = useState(false), [help, setHelp] = useState(false);
  const trigger = useRef<React.ComponentRef<typeof View>>(null);
  const closeHelp = () => { setHelp(false); requestAnimationFrame(() => trigger.current?.focus()); };
  return <View style={{ gap: 8 }}>
    {preview ? <View accessibilityLabel="Notes preview" role="region" style={{ minHeight: 100, gap: 8 }}><Text style={ui.label}>Notes (optional)</Text>{value.trim() ? <MarkdownNotes source={value} /> : <Text style={ui.caption}>Nothing to preview yet.</Text>}</View>
      : <TextField autoCorrect={false} label="Notes (optional)" value={value} onChangeText={onChange} multiline style={{ minHeight: 100, textAlignVertical: 'top' }} maxLength={2000} editable={!disabled} />}
    <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 4 }}>
      <Button title={preview ? 'Write' : 'Preview'} icon={preview ? 'edit' : 'bill'} kind="text" compact disabled={disabled} onPress={() => setPreview(value => !value)} />
      <Button ref={trigger} title="Formatting help" icon="help" kind="text" compact onPress={() => setHelp(true)} />
      <Text style={[ui.caption, { marginLeft: 'auto' }]}>{value.length}/2,000</Text>
    </View>
    <KeyboardDialog visible={help} label="Formatting help" placement="bottom" onDismiss={closeHelp}>
      <Dialog.Title icon="help">Formatting help</Dialog.Title><DialogScrollBody gap={12}>
        <Text style={ui.body}>Supports Markdown, including tables.</Text>
        <Text selectable style={[ui.body, { fontFamily: 'monospace' }]}>{example}</Text>
        <Text style={ui.caption}>Images appear as text. HTML appears as written. Add photos and PDFs using the attachment button.</Text>
      </DialogScrollBody><CloseDialogActions title="Done" onClose={closeHelp} />
    </KeyboardDialog>
  </View>;
}
