import React from 'react';
import { View } from 'react-native';
import { Switch, Text } from 'react-native-paper';
import { Icon, useUI, type IconName } from './ui';

export default function NotificationSwitch({ icon, label, checked, disabled, onChange }: { icon: IconName; label: string; checked: boolean; disabled: boolean; onChange: (value: boolean) => void }) {
  const { ui, palette } = useUI();
  return <View style={{ flexDirection: 'row', alignItems: 'center', minHeight: 48, gap: 12 }}>
    <View aria-hidden><Icon name={icon} /></View><Text style={[ui.body, { flex: 1 }]}>{label}</Text>
    <Switch accessibilityLabel={label} value={checked} disabled={disabled} trackColor={{ false: palette.outline, true: disabled ? palette.outline : '#007AFF' }} thumbColor="#FFFFFF" ios_backgroundColor={palette.outline} onValueChange={onChange} />
  </View>;
}
