import React from 'react';
import { View } from 'react-native';
import { Switch, Text } from 'react-native-paper';
import { Icon, useUI, type IconName } from './ui';
import ListRow from './ListRow';

export default function NotificationSwitch({ icon, label, description, checked, disabled, onChange }: { icon: IconName; label: string; description?: string; checked: boolean; disabled: boolean; onChange: (value: boolean) => void }) {
  const { ui, palette } = useUI();
  return <ListRow divider={false} leading={<View aria-hidden><Icon name={icon} /></View>} trailing={
    <Switch accessibilityLabel={label} accessibilityHint={description} style={{ alignSelf: 'center' }} value={checked} disabled={disabled} trackColor={{ false: palette.outline, true: disabled ? palette.outline : palette.switchOn }} thumbColor="#FFFFFF" ios_backgroundColor={palette.outline} onValueChange={onChange} />}>
    <Text style={ui.body}>{label}</Text>{description && <Text style={ui.caption}>{description}</Text>}
  </ListRow>;
}
