import React, { useEffect, useState } from 'react';
import { AccessibilityInfo, Platform, View } from 'react-native';
import { requireOptionalNativeModule } from 'expo';
import type { ChatComposerSurfaceProps } from './ChatComposerSurface';
import { useUI } from './ui';

let GlassView: typeof import('expo-glass-effect')['GlassView'] | null = null;
try {
  // Older installed builds lack the module. Do not evaluate its JS in those builds.
  if (Number.parseInt(String(Platform.Version), 10) >= 26 && requireOptionalNativeModule('ExpoGlassEffect')) {
    const glass = require('expo-glass-effect') as typeof import('expo-glass-effect');
    if (glass.isLiquidGlassAvailable() && glass.isGlassEffectAPIAvailable()) GlassView = glass.GlassView;
  }
} catch { /* Keep the opaque composer when the runtime cannot provide native glass. */ }

export default function ChatComposerSurface({ children, style, interactive = false, tintColor }: ChatComposerSurfaceProps) {
  const { palette, dark, motion } = useUI();
  const [reduced, setReduced] = useState(true);
  useEffect(() => {
    if (!GlassView) return;
    setReduced(true);
    let mounted = true, revision = 0;
    const subscription = AccessibilityInfo.addEventListener('reduceTransparencyChanged', value => { revision++; if (mounted) setReduced(value); });
    const current = revision;
    void AccessibilityInfo.isReduceTransparencyEnabled().then(value => { if (mounted && current === revision) setReduced(value); }).catch(() => { /* Retain the opaque fallback. */ });
    return () => { mounted = false; subscription.remove(); };
  }, [motion.active]);
  return GlassView && !reduced && motion.enabled
    ? <GlassView style={style} isInteractive={interactive} tintColor={tintColor} glassEffectStyle="regular" colorScheme={dark ? 'dark' : 'light'}>{children}</GlassView>
    : <View style={[style, { backgroundColor: tintColor ?? palette.surface }]}>{children}</View>;
}
