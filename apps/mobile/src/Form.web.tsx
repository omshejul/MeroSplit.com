import React from 'react';
import { StyleSheet } from 'react-native';
import type { FormProps } from './Form';
export default function Form({ children, style, label, onSubmit }: FormProps) {
  return React.createElement('form', { 'aria-label': label, noValidate: true,
    onSubmit: (event: React.FormEvent) => { event.preventDefault(); onSubmit(); },
    style: { display: 'flex', flexDirection: 'column', margin: 0, gap: 12, ...StyleSheet.flatten(style) } as React.CSSProperties,
  }, children);
}
