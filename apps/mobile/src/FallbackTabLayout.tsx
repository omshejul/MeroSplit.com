import React, { useRef } from 'react';
import { Animated, View } from 'react-native';
import { AppTabs } from './AppNavigation';
import { useHomeTabSwipe } from './useHomeTabSwipe';
import type { HomeTabsProps } from './HomeTabs';
export default function FallbackTabLayout({ selected, busy, onSelect, render }: HomeTabsProps) {
  const visited = useRef(new Set<string>()); visited.current.add(selected);
  const swipe = useHomeTabSwipe(selected, busy, onSelect);
  return <><View style={{ flex: 1, overflow: 'hidden' }}>{Array.from(visited.current).map(tab => <Animated.View key={tab} {...(tab === selected ? swipe : { style: { flex: 1, display: 'none' as const } })}>{render(tab)}</Animated.View>)}</View><AppTabs selected={selected} busy={busy} onSelect={onSelect} /></>;
}
