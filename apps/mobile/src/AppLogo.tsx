import React from 'react';
import { Image } from 'react-native';
export default function AppLogo({ size = 32 }: { size?: number }) {
  return <Image source={require('../assets/brand/mark.png')} accessible={false} aria-hidden accessibilityIgnoresInvertColors style={{ width: size, height: size }} />;
}
