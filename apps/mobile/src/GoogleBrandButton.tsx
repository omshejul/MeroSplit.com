import React from 'react';
import { Image, Platform, Pressable } from 'react-native';
import { useUI } from './ui';

export type GoogleBrandButtonProps = { disabled: boolean; onPress: () => void };

// Unmodified, preapproved Google assets. Metro selects the native density variant.
export default function GoogleBrandButton({ disabled, onPress }: GoogleBrandButtonProps) {
  const { dark } = useUI();
  const ios = Platform.OS === 'ios';
  const source = ios
    ? dark ? require('../assets/oauth/google-ios-dark.png') : require('../assets/oauth/google-ios-light.png')
    : dark ? require('../assets/oauth/google-android-dark.png') : require('../assets/oauth/google-android-light.png');
  return <Pressable accessibilityRole="button" accessibilityLabel="Sign in with Google" accessibilityState={{ disabled }}
    disabled={disabled} onPress={onPress} style={({ pressed }) => ({ width: 216, height: 48, alignItems: 'center', justifyContent: 'center', opacity: disabled ? 0.5 : pressed ? 0.7 : 1 })}>
    <Image source={source} accessible={false} importantForAccessibility="no" resizeMode="contain"
      style={{ width: ios ? 188 / 44 * 48 : 216, height: 48 }} />
  </Pressable>;
}
