import React from 'react';
import { Image } from 'react-native';
import { Text } from 'react-native-paper';
import { Button, useUI } from './ui';
import type { GoogleBrandButtonProps } from './GoogleBrandButton';
import { googleFontFamily } from './typography';

export default function GoogleBrandButton({ disabled, onPress }: GoogleBrandButtonProps) {
  const { dark, ui } = useUI();
  return <Button kind="plain" accessibilityRole="button" accessibilityLabel="Continue with Google" accessibilityState={{ disabled }}
    disabled={disabled} onPress={onPress}
    style={({ pressed }) => ({ width: '100%', maxWidth: 400, minHeight: 48, paddingVertical: 10, paddingHorizontal: 12,
      flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, borderRadius: 12, borderWidth: 1,
      backgroundColor: dark ? '#131314' : '#FFFFFF', borderColor: dark ? '#8E918F' : '#747775',
      opacity: disabled ? 0.5 : pressed ? 0.8 : 1 })}>
    <Image source={dark ? require('../assets/oauth/google-g-dark.svg') : require('../assets/oauth/google-g-light.svg')}
      accessible={false} aria-hidden={true} accessibilityLabel="" resizeMode="contain" style={{ width: 20, height: 20, flexShrink: 0 }} />
    <Text style={{ flexShrink: 1, textAlign: 'center', fontFamily: ui.body.fontFamily ? googleFontFamily : undefined,
      fontSize: 14, lineHeight: 20, fontWeight: '500', color: dark ? '#E3E3E3' : '#1F1F1F' }}>Continue with Google</Text>
  </Button>;
}
