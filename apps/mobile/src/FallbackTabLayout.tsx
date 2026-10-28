import React from 'react';
import { Animated, View } from 'react-native';
import { AppTabs } from './AppNavigation';
import { useHomeTabSwipe } from './useHomeTabSwipe';
import type { HomeTabsProps } from './HomeTabs';
export default function FallbackTabLayout({ selected, busy, onSelect, render }: HomeTabsProps) {
  const swipe = useHomeTabSwipe(selected, busy, onSelect);
  return <><View style={{ flex: 1, overflow: 'hidden' }}><Animated.View {...swipe}>{render(selected)}</Animated.View></View><AppTabs selected={selected} busy={busy} onSelect={onSelect} /></>;
}
