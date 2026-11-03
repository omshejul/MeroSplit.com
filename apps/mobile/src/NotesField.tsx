import React from 'react';
import { View } from 'react-native';
import { Text } from 'react-native-paper';
import { useUI } from './ui';
import { TextField } from './FormFields';

export default function NotesField({ value, disabled, onChange }: { value: string; disabled: boolean; onChange: (value: string) => void }) {
  const { ui } = useUI();
  return <View style={{ gap: 8 }}>
    <View style={{ flexDirection: 'row', alignItems: 'baseline', flexWrap: 'wrap', gap: 8 }}>
      <Text style={ui.label}>Notes (optional)</Text>
      <Text style={[ui.caption, { marginLeft: 'auto' }]}>Markdown</Text>
    </View>
    <TextField autoCorrect={false} label="Notes (optional)" hideLabel value={value} onChangeText={onChange} multiline style={{ minHeight: 100, textAlignVertical: 'top' }} maxLength={2000} editable={!disabled} />
    <Text style={[ui.caption, { alignSelf: 'flex-end' }]}>{value.length}/2,000</Text>
  </View>;
}
