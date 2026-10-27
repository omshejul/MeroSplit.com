import React, { useEffect, useState } from 'react';
import { Image, Platform, ScrollView, View } from 'react-native';
import { Text } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { IconAction, useUI } from './ui';
import { signInTopPadding } from './authLayoutMetrics';

export default function SignInLayout({ children, busy, onBack }: { children: React.ReactNode; busy: boolean; onBack?: () => void }) {
  const { palette, ui } = useUI(), insets = useSafeAreaInsets();
  const [height, setHeight] = useState(0), [contentHeight, setContentHeight] = useState(0);
  const [visualHeight, setVisualHeight] = useState<number>();
  useEffect(() => {
    if (Platform.OS !== 'web' || !window.visualViewport) return;
    const viewport = window.visualViewport;
    const resize = () => setVisualHeight(viewport.height);
    resize(); viewport.addEventListener('resize', resize);
    return () => viewport.removeEventListener('resize', resize);
  }, []);
  return <View testID="signin-viewport" style={{ flex: 1, ...(visualHeight !== undefined && { maxHeight: Math.max(0, visualHeight - insets.top - insets.bottom) }) }} onLayout={event => setHeight(event.nativeEvent.layout.height)}>
    <ScrollView role="main" keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag"
      contentContainerStyle={{ flexGrow: 1, paddingHorizontal: 24, paddingTop: signInTopPadding(height, contentHeight), paddingBottom: 24 }}>
      <View testID="signin-group" style={{ width: '100%', maxWidth: 380, alignSelf: 'center', gap: 24 }} onLayout={event => setContentHeight(event.nativeEvent.layout.height)}>
        {onBack && <View style={{ alignSelf: 'flex-start' }}><IconAction name="back" label="Back" disabled={busy} onPress={onBack} /></View>}
        <View style={{ alignItems: 'center', gap: 12 }}>
          <Image source={require('../assets/brand/mark.png')} accessible={false} aria-hidden={true} style={{ width: 40, height: 40 }} />
          <View style={{ gap: 8, width: '100%' }}>
            <Text accessibilityRole="header" aria-level={1} style={[ui.section, { fontSize: 26, lineHeight: 32, textAlign: 'center' }]}>Sign in to MeroSplit</Text>
            <Text style={[ui.body, { color: palette.muted, textAlign: 'center', lineHeight: 22 }]}>Split costs with friends, trips and households.</Text>
          </View>
        </View>
        {children}
      </View>
    </ScrollView>
  </View>;
}
