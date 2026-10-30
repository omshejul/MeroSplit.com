import FallbackTabLayout from './FallbackTabLayout';
import React, { useRef } from 'react';
import { Animated, Platform } from 'react-native';
import { Tabs } from 'react-native-screens';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import type { HomeTabsProps } from './HomeTabs';
import { useUI } from './ui';
import { useHomeTabSwipe } from './useHomeTabSwipe';

// Older iOS keeps the rounded app bar. iOS 26+ owns the entire glass control.
export const usesNativeHomeTabs = Number.parseInt(String(Platform.Version), 10) >= 26;
const tabs = [
  { value: 'Groups', label: 'Groups', symbol: 'person.3', selectedSymbol: 'person.3.fill' },
  { value: 'Friends', label: 'People', symbol: 'person.2', selectedSymbol: 'person.2.fill' },
  { value: 'Activity', label: 'Activity', symbol: 'clock', selectedSymbol: 'clock.fill' },
  { value: 'Account', label: 'Me', symbol: 'person.crop.circle', selectedSymbol: 'person.crop.circle.fill' },
] as const;

export default function HomeTabs({ selected, busy, onSelect, render }: HomeTabsProps) {
  const { palette, dark } = useUI();
  const provenance = useRef(0);
  const swipe = useHomeTabSwipe(selected, busy, onSelect);
  if (!usesNativeHomeTabs) return <FallbackTabLayout selected={selected} busy={busy} onSelect={onSelect} render={render} />;
  return <Tabs.Host
    colorScheme={dark ? 'dark' : 'light'}
    nativeContainerStyle={{ backgroundColor: palette.background }}
    navStateRequest={{ selectedScreenKey: selected, baseProvenance: provenance.current }}
    ios={{ tabBarTintColor: palette.accent, tabBarMinimizeBehavior: 'never', tabBarControllerMode: 'tabBar' }}
    onTabSelected={({ nativeEvent }) => {
      provenance.current = nativeEvent.provenance;
      if (!busy && (nativeEvent.actionOrigin === 'user' || nativeEvent.actionOrigin === 'implicit')) onSelect(nativeEvent.selectedScreenKey);
    }}>
    {tabs.map(tab => <Tabs.Screen key={tab.value} screenKey={tab.value} title={tab.label}
      tabBarItemAccessibilityLabel={tab.label} tabBarItemTestID={`tab-${tab.value}`}
      preventNativeSelection={busy}
      specialEffects={{ repeatedTabSelection: { popToRoot: false, scrollToTop: false } }}
      style={{ backgroundColor: palette.background }}
      ios={{ icon: { type: 'sfSymbol', name: tab.symbol }, selectedIcon: { type: 'sfSymbol', name: tab.selectedSymbol } }}>
      <SafeAreaProvider><SafeAreaView edges={['bottom']} style={{ flex: 1 }}>
        {selected === tab.value ? <Animated.View {...swipe}>{render(tab.value)}</Animated.View> : null}
      </SafeAreaView></SafeAreaProvider>
    </Tabs.Screen>)}
  </Tabs.Host>;
}
