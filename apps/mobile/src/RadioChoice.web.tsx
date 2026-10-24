import React from 'react';
import type { RadioChoiceProps } from './RadioChoice';
import { useUI } from './ui';

export default function RadioChoice({ label, value, selected, disabled, onPress, accessibilityLabel = label, group }: RadioChoiceProps) {
  const { palette, dark } = useUI();
  return <label style={{ display: 'flex', alignItems: 'center', gap: 12, minHeight: 48, padding: '12px 16px', boxSizing: 'border-box',
    color: disabled ? palette.muted : palette.text, fontFamily: 'StackSansText, sans-serif', fontSize: 16, lineHeight: '24px', cursor: disabled ? 'default' : 'pointer' }}>
    <span style={{ flex: 1 }}>{label}</span>
    <input type="radio" name={group} value={value} checked={selected} disabled={disabled} aria-label={accessibilityLabel} onChange={onPress}
      style={{ width: 20, height: 20, margin: 0, accentColor: palette.accent, colorScheme: dark ? 'dark' : 'light', flexShrink: 0 }} />
  </label>;
}
