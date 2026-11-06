import React, { useEffect, useRef, useState } from 'react';
import { Switch, View } from 'react-native';
import { Text } from 'react-native-paper';
import { Button, Icon, useUI, type IconName } from './ui';
import ListRow from './ListRow';

export default function NotificationSwitch({ icon, label, description, checked, disabled, onChange, immediate = true }: { icon: IconName; label: string; description?: string; checked: boolean; disabled: boolean; immediate?: boolean; onChange: (value: boolean) => void }) {
  const { ui, palette } = useUI();
  const [value, setValue] = useState(checked), latest = useRef(checked);
  useEffect(() => { latest.current = checked; setValue(checked); }, [checked]);
  function change(next: boolean) {
    if (disabled || next === (immediate ? latest.current : checked)) return;
    if (immediate) { latest.current = next; setValue(next); }
    onChange(next);
  }
  const shown = immediate ? value : checked;
  // The label and native switch are siblings, so a switch tap cannot also
  // invoke a parent row handler. The native control owns accessibility.
  return <ListRow divider={false} style={{ minHeight: 56, paddingVertical: 4 }} trailing={
    <Switch accessibilityLabel={label} accessibilityHint={description} value={shown} disabled={disabled} onValueChange={change} trackColor={{ true: palette.switchOn }} />}>
    <Button kind="plain" accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" aria-hidden tabIndex={-1} disabled={disabled}
      onPress={() => change(!(immediate ? latest.current : checked))} style={{ minHeight: 48, flexDirection: 'row', alignItems: 'center', alignSelf: 'stretch', gap: 12 }}>
      <Icon name={icon} /><View style={{ flex: 1 }}><Text style={ui.body}>{label}</Text>{description && <Text style={ui.caption}>{description}</Text>}</View>
    </Button>
  </ListRow>;
}
