import React from 'react';
import { StyleSheet } from 'react-native';
import type { Text } from 'react-native-paper';

export default function FieldLabel({ nativeID, style, children }: React.ComponentProps<typeof Text>) {
  const text = StyleSheet.flatten(style);
  return React.createElement('label', { htmlFor: nativeID, style: { ...text, display: 'block', lineHeight: text?.lineHeight ? `${text.lineHeight}px` : undefined } as React.CSSProperties }, children);
}
