import React from 'react';
import { Animated, View } from 'react-native';
import { AppTabs } from './AppNavigation';
import { useHomeTabSwipe } from './useHomeTabSwipe';

export type HomeTabsProps = {
  selected: string;
  busy: boolean;
  onSelect: (tab: string) => void;
  render: (tab: string) => React.ReactNode;
};

export const usesNativeHomeTabs = false;

export default function HomeTabs({ selected, busy, onSelect, render }: HomeTabsProps) {
  const swipe = useHomeTabSwipe(selected, busy, onSelect);
  return <><View style={{ flex: 1, overflow: 'hidden' }}><Animated.View {...swipe}>{render(selected)}</Animated.View></View><AppTabs selected={selected} busy={busy} onSelect={onSelect} /></>;
}
