import FallbackTabLayout from './FallbackTabLayout';
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
  return <FallbackTabLayout selected={selected} busy={busy} onSelect={onSelect} render={render} />;
}
