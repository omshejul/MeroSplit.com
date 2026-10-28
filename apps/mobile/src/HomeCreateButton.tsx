import React from 'react';
import { Platform, View } from 'react-native';
import { pageWidthStyle } from './AppNavigation';
import { Button, Icon, useUI } from './ui';
import GlassSurface from './ChatComposerSurface';

// Custom tabs already sit outside the content area. Native iOS tabs overlay it.
export default function HomeCreateButton({ direct, disabled, onPress, onHeight }: { direct: boolean; disabled: boolean; onPress: () => void; onHeight?: (height: number) => void }) {
  const { palette } = useUI(), ios = Platform.OS === 'ios';
  const nativeTabs = ios && Number.parseInt(String(Platform.Version), 10) >= 26;
  const Surface = nativeTabs ? (require('react-native-screens/experimental') as typeof import('react-native-screens/experimental')).SafeAreaView : View;
  const button = <Button title={direct ? 'Add person' : 'Add group'}
    icon={({ color }) => <Icon name="add" color={color} />}
    kind="primary"
    disabled={disabled} onPress={onPress} style={{ minHeight: 48, borderRadius: 999, maxWidth: '100%', paddingHorizontal: 16, paddingVertical: 8, justifyContent: 'center', backgroundColor: ios ? 'transparent' : palette.accent }} />;
  return <Surface collapsable={false} pointerEvents="box-none" {...(nativeTabs ? { edges: { bottom: true } } : {})}
    style={{ position: 'absolute', left: 0, right: 0, bottom: 0, flex: 0, zIndex: 1 }}>
    <View pointerEvents="box-none" onLayout={event => onHeight?.(event.nativeEvent.layout.height)} style={[pageWidthStyle, { width: '100%', alignItems: 'flex-end', paddingHorizontal: 16, paddingBottom: 16 }]}>
      {ios ? <GlassSurface tintColor={palette.accent} interactive={!disabled} style={{ borderRadius: 999, maxWidth: '100%', borderWidth: 1, borderColor: palette.line }}>{button}</GlassSurface> : button}
    </View>
  </Surface>;
}

// Native tab bars overlay scroll content, so its footer needs their real inset too.
export function HomeCreateInset() {
  if (Platform.OS !== 'ios' || Number.parseInt(String(Platform.Version), 10) < 26) return null;
  const { SafeAreaView } = require('react-native-screens/experimental') as typeof import('react-native-screens/experimental');
  return <SafeAreaView pointerEvents="none" edges={{ bottom: true }} style={{ flex: 0 }} />;
}
