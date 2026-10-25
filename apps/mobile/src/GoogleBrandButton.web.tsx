import React from 'react';
import { Image, Pressable } from 'react-native';
import { useUI } from './ui';
import type { GoogleBrandButtonProps } from './GoogleBrandButton';

export default function GoogleBrandButton({ disabled, onPress }: GoogleBrandButtonProps) {
  const { dark } = useUI();
  return <Pressable accessibilityRole="button" accessibilityLabel="Sign in with Google" accessibilityState={{ disabled }}
    disabled={disabled} onPress={onPress} style={({ pressed }) => ({ width: 216, height: 48, opacity: disabled ? 0.5 : pressed ? 0.7 : 1 })}>
    <Image source={dark ? require('../assets/oauth/google-web-dark.svg') : require('../assets/oauth/google-web-light.svg')}
      accessibilityLabel="" aria-hidden={true} accessible={false} resizeMode="contain" style={{ width: 216, height: 48 }} />
  </Pressable>;
}
