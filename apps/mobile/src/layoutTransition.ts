import { LayoutAnimation } from 'react-native';
let scheduled = false;
// Schedule before a state update. Coalesce nested controls in the same event.
export function animateLayout(enabled: boolean) {
  if (!enabled || scheduled) return;
  scheduled = true;
  LayoutAnimation.configureNext({ duration: 180, create: { type: 'easeInEaseOut', property: 'opacity' }, update: { type: 'easeInEaseOut' }, delete: { type: 'easeInEaseOut', property: 'opacity' } });
  queueMicrotask(() => { scheduled = false; });
}
