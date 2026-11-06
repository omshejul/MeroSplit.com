import React from 'react';
import { Platform } from 'react-native';
import BottomSafeArea from './BottomSafeArea';

// Full-page iOS scrollers own the home-indicator space. The keyboard replaces it.
export default function ScrollBottomInset() {
  return Platform.OS === 'ios' ? <BottomSafeArea pointerEvents="none" style={{ flex: 0 }} /> : null;
}
