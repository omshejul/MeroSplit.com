import React, { useEffect, useRef, useState } from 'react';
import { Platform, View } from 'react-native';
import { Text } from 'react-native-paper';
import { Icon, useUI, type IconName } from './ui';
import ListRow from './ListRow';

// One press target owns both the row and thumb. Its visual value changes in
// this component, before persistence or an app-wide render can finish.
export default function NotificationSwitch({ icon, label, description, checked, disabled, onChange, immediate = true }: { icon: IconName; label: string; description?: string; checked: boolean; disabled: boolean; immediate?: boolean; onChange: (value: boolean) => void }) {
  const { ui, palette } = useUI();
  const [value, setValue] = useState(checked), latest = useRef(checked);
  useEffect(() => { latest.current = checked; setValue(checked); }, [checked]);
  function toggle() {
    if (disabled) return;
    const next = !(immediate ? latest.current : checked);
    if (immediate) { latest.current = next; setValue(next); }
    onChange(next);
  }
  const shown = immediate ? value : checked;
  return <ListRow accessibilityRole="switch" accessibilityLabel={label} accessibilityHint={description} accessibilityState={{ checked: shown, disabled }} aria-checked={shown} aria-disabled={disabled} disabled={disabled} onPress={toggle} divider={false}
    {...(Platform.OS === 'web' ? { onKeyDown: (event: Parameters<NonNullable<React.ComponentProps<typeof ListRow>['onKeyDown']>>[0]) => { if (event.nativeEvent.key === ' ' && !event.nativeEvent.repeat) { event.preventDefault(); toggle(); } } } : {})}
    style={{ minHeight: 56, paddingVertical: 10 }} leading={<View aria-hidden><Icon name={icon} /></View>}
    trailing={<View pointerEvents="none" aria-hidden accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
      style={{ width: 52, height: 32, borderRadius: 16, padding: 3, justifyContent: 'center', backgroundColor: shown ? palette.switchOn : palette.outline, opacity: disabled ? .5 : 1 }}>
      <View style={{ width: 26, height: 26, borderRadius: 13, backgroundColor: '#FFFFFF', alignSelf: shown ? 'flex-end' : 'flex-start' }} />
    </View>}>
    <Text style={ui.body}>{label}</Text>{description && <Text style={ui.caption}>{description}</Text>}
  </ListRow>;
}
