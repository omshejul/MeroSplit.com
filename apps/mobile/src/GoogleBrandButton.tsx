import React, { useState } from 'react';
import { Image, Platform } from 'react-native';
import { Text } from 'react-native-paper';
import { Button, useUI } from './ui';
import { googleFontFamily } from './typography';

export type GoogleBrandButtonProps = { disabled: boolean; onPress: () => void };

export default function GoogleBrandButton({ disabled, onPress }: GoogleBrandButtonProps) {
  const { dark, palette, ui } = useUI(), [focused, setFocused] = useState(false);
  const ios = Platform.OS === 'ios';
  return <Button kind="plain" accessibilityRole="button" accessibilityLabel="Continue with Google" accessibilityState={{ disabled }}
    disabled={disabled} onPress={onPress} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
    style={({ pressed }) => ({ width: '100%', maxWidth: 400, minHeight: 48, paddingVertical: 10, paddingHorizontal: ios ? 16 : 12,
      flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: ios ? 12 : 10, borderRadius: 12, borderWidth: 1,
      backgroundColor: dark ? '#131314' : '#FFFFFF', borderColor: focused ? palette.accent : dark ? '#8E918F' : '#747775',
      outlineWidth: focused ? 2 : 0, outlineStyle: 'solid', outlineColor: palette.accent, outlineOffset: 3, opacity: disabled ? 0.5 : pressed ? 0.8 : 1 })}>
    <Image source={dark ? require('../assets/oauth/google-g-dark.png') : require('../assets/oauth/google-g-light.png')}
      accessible={false} importantForAccessibility="no" resizeMode="contain" style={{ width: 20, height: 20, flexShrink: 0 }} />
    <Text style={{ flexShrink: 1, textAlign: 'center', fontFamily: ui.body.fontFamily ? googleFontFamily : undefined,
      fontSize: 14, lineHeight: 20, fontWeight: '500', color: dark ? '#E3E3E3' : '#1F1F1F' }}>Continue with Google</Text>
  </Button>;
}
