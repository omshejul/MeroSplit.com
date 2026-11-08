import React, { useRef } from 'react';
import { View } from 'react-native';
import { AppTabs } from './AppNavigation';
import { useHomeTabSwipe } from './useHomeTabSwipe';
import type { HomeTabsProps } from './HomeTabs';
export default function FallbackTabLayout({ selected, busy, onSelect, render }: HomeTabsProps) {
  const visited = useRef(new Set<string>()); visited.current.add(selected);
  const swipe = useHomeTabSwipe(selected, busy, onSelect);
  return <><View style={{ flex: 1, overflow: 'hidden' }}>{Array.from(visited.current).map(tab => <View key={tab} pointerEvents={tab === selected ? 'auto' : 'none'} aria-hidden={tab === selected ? undefined : true} accessibilityElementsHidden={!(tab === selected)} importantForAccessibility={tab === selected ? 'auto' : 'no-hide-descendants'} {...(tab === selected ? swipe : { style: { position: 'absolute' as const, top: 0, right: 0, bottom: 0, left: 0, opacity: 0 } })}>{render(tab)}</View>)}</View><AppTabs selected={selected} busy={busy} onSelect={onSelect} /></>;
}
