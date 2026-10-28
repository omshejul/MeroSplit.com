import React from 'react';
import { Platform } from 'react-native';
import { Alert } from './alerts';
import { SettingsRow } from './ui';

export default function AttachmentPicker({ disabled, onPick }: { disabled: boolean; onPick: (photo: boolean) => void }) {
  return <SettingsRow label="Add photo or PDF" icon="attachment" chevron={false} disabled={disabled} onPress={() => {
    if (disabled) return;
    if (Platform.OS === 'web') onPick(false);
    else Alert.alert('Add photo or PDF', undefined, [{ text: 'Cancel', style: 'cancel' }, { text: 'Photo', onPress: () => onPick(true) }, { text: 'Files', onPress: () => onPick(false) }]);
  }} />;
}
