import React from 'react';
import { Platform } from 'react-native';
import { Button, Icon, useUI } from './ui';
import GlassSurface from './ChatComposerSurface';

export default function AddActionButton({ title, disabled, onPress }: { title: string; disabled: boolean; onPress: () => void }) {
  const { palette } = useUI(), ios = Platform.OS === 'ios';
  const button = <Button title={title}
    icon={({ color }) => <Icon name="add" color={color} />}
    kind="primary"
    disabled={disabled} onPress={onPress} style={{ minHeight: 48, borderRadius: 999, maxWidth: '100%', paddingHorizontal: 16, paddingVertical: 8, justifyContent: 'center', backgroundColor: ios ? 'transparent' : palette.accent }} />;
  return ios ? <GlassSurface tintColor={palette.accent} interactive={!disabled} style={{ borderRadius: 999, maxWidth: '100%', borderWidth: 1, borderColor: palette.line }}>{button}</GlassSurface> : button;
}
