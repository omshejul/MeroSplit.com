import React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { Text } from 'react-native-paper';
import { Button, Icon, useUI } from './ui';

export default function AttachmentTile({ thumbnail, count = 0, warning = false, loading = false, canAdd = false, label, disabled, onPress, triggerRef }: {
  thumbnail?: React.ReactNode; count?: number; warning?: boolean; loading?: boolean; canAdd?: boolean;
  label: string; disabled: boolean; onPress: () => void; triggerRef?: React.Ref<React.ComponentRef<typeof View>>;
}) {
  const { palette } = useUI();
  return <View style={{ width: 80, height: 80, flexShrink: 0 }}>
    <Button kind="plain" ref={triggerRef} accessibilityLabel={label} accessibilityState={{ busy: loading }} disabled={disabled} onPress={onPress}
      style={{ width: 80, height: 80, borderRadius: 8, borderWidth: 1, borderColor: palette.outline, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
      <View pointerEvents="none" accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" aria-hidden>
        {loading ? <ActivityIndicator color={palette.accent} /> : thumbnail ?? <Icon name="attachment" size={28} />}
      </View>
      {!thumbnail && !loading && canAdd && <View pointerEvents="none" accessible={false} aria-hidden style={{ position: 'absolute', top: 9, right: 9, width: 18, height: 18, borderRadius: 9, backgroundColor: palette.accent, alignItems: 'center', justifyContent: 'center' }}><Icon name="add" size={12} color={palette.background} /></View>}
    </Button>
    {!loading && (warning || count > 0) && <View pointerEvents="none" accessible={false} aria-hidden style={{ position: 'absolute', top: -5, right: -5, minWidth: 22, height: 22, paddingHorizontal: 4, borderRadius: 11, borderWidth: 2, borderColor: palette.background, backgroundColor: warning ? palette.warning : palette.text, alignItems: 'center', justifyContent: 'center' }}><Text maxFontSizeMultiplier={1.2} style={{ fontSize: 12, lineHeight: 16, fontWeight: '600', color: palette.background }}>{warning ? '!' : count}</Text></View>}
  </View>;
}
