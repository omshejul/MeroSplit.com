import React, { useRef, useState } from 'react';
import { Keyboard, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { Text } from 'react-native-paper';
import { Button, useUI } from './ui';
import KeyboardDialog from './KeyboardDialog';
import { CloseDialogActions, Dialog, DialogScrollBody } from './DialogParts';
import { TextField } from './FormFields';

// Markdown Mark by Dustin Curtis, dedicated to the public domain (CC0).
// https://github.com/dcurtis/markdown-mark
function MarkdownMark({ color }: { color: string }) {
  return <Svg width={28} height={18} viewBox="0 0 208 128" accessible={false}>
    <Path fill={color} fillRule="evenodd" d="m15 10c-2.7614 0-5 2.2386-5 5v98c0 2.761 2.2386 5 5 5h178c2.761 0 5-2.239 5-5v-98c0-2.7614-2.239-5-5-5zm-15 5c0-8.28427 6.71573-15 15-15h178c8.284 0 15 6.71573 15 15v98c0 8.284-6.716 15-15 15h-178c-8.28427 0-15-6.716-15-15z" />
    <Path fill={color} d="m30 98v-68h20l20 25 20-25h20v68h-20v-39l-20 25-20-25v39zm125 0-30-33h20v-35h20v35h20z" />
  </Svg>;
}
const example = '**Bold** and *italic*\n\n- List item\n- [x] Completed task\n\n[Link](https://example.com)\n\n| Item | Amount |\n| --- | ---: |\n| Dinner | ₹500 |';

export default function NotesField({ value, disabled, onChange }: { value: string; disabled: boolean; onChange: (value: string) => void }) {
  const { ui } = useUI(), [help, setHelp] = useState(false);
  const trigger = useRef<React.ComponentRef<typeof View>>(null);
  const closeHelp = () => { setHelp(false); requestAnimationFrame(() => trigger.current?.focus()); };
  return <View style={{ gap: 8 }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
      <Text style={ui.label}>Notes (optional)</Text>
      <Button ref={trigger} kind="secondary" small iconOnly icon={({ color }) => <MarkdownMark color={color} />} accessibilityLabel="Markdown formatting help" accessibilityHint="Shows examples for formatting notes" onPress={() => { Keyboard.dismiss(); setHelp(true); }} hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }} style={{ marginLeft: 'auto', minWidth: 44, height: 28, minHeight: 28, borderRadius: 8 }} />
    </View>
    <TextField autoCorrect={false} label="Notes (optional)" hideLabel value={value} onChangeText={onChange} multiline style={{ minHeight: 100, textAlignVertical: 'top' }} maxLength={2000} editable={!disabled} />
    <Text style={[ui.caption, { alignSelf: 'flex-end' }]}>{value.length}/2,000</Text>
    <KeyboardDialog visible={help} label="Markdown formatting help" placement="bottom" onDismiss={closeHelp}>
      <Dialog.Title icon="help">Markdown</Dialog.Title><DialogScrollBody gap={12}>
        <Text style={ui.body}>Notes support Markdown, including tables.</Text>
        <Text selectable style={[ui.body, { fontFamily: 'monospace' }]}>{example}</Text>
        <Text style={ui.caption}>Formatting appears when you save. Add photos and PDFs using the attachment button.</Text>
      </DialogScrollBody><CloseDialogActions title="Done" onClose={closeHelp} />
    </KeyboardDialog>
  </View>;
}
