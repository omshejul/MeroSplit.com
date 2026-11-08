import React, { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import type ScrollView from './KeyboardScrollView';
import { Button, useUI } from './ui';

export type BillHistoryCue = { id: string; active: boolean; scroll: React.RefObject<React.ComponentRef<typeof ScrollView> | null> };

export default function BillHistoryButton({ disabled, onPress, cue }: { disabled: boolean; onPress: () => void; cue?: BillHistoryCue }) {
  const { palette, motion } = useUI();
  const [laidOut, setLaidOut] = useState(false), [highlight, setHighlight] = useState(false);
  const button = useRef<React.ComponentRef<typeof View>>(null), played = useRef<string | undefined>(undefined);
  const latest = useRef({ onPress, motion, active: cue?.active, disabled }); latest.current = { onPress, motion, active: cue?.active, disabled };
  const id = cue?.id, active = cue?.active, scroll = cue?.scroll;
  useEffect(() => {
    if (!id || !active || disabled || !laidOut || played.current === id) return;
    played.current = id;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const valid = () => !cancelled && latest.current.active && !latest.current.disabled;
    const frame = requestAnimationFrame(() => {
      const container = scroll?.current, anchor = button.current, inner = container?.getInnerViewRef();
      if (!container || !anchor || !inner) return;
      anchor.measureLayout(inner, (_x, y, _width, buttonHeight) => {
        if (!valid()) return;
        container.measureInWindow((_left, _top, _vw, height) => {
          if (!valid()) return;
          const needsScroll = y + buttonHeight > height - 12;
          const animate = needsScroll && latest.current.motion.enabled;
          if (needsScroll) container.scrollTo({ y: Math.max(0, y - 80), animated: animate });
          setHighlight(true);
          timer = setTimeout(() => { if (valid()) latest.current.onPress(); }, animate ? 700 : 450);
        });
      });
    });
    return () => { cancelled = true; cancelAnimationFrame(frame); clearTimeout(timer); setHighlight(false); };
  }, [id, active, disabled, laidOut, scroll]);

  return <View ref={button} collapsable={false} onLayout={id ? () => setLaidOut(true) : undefined}>
    <Button title="Version history" icon="history" kind="outlined" disabled={disabled} onPress={onPress}
      style={highlight && { backgroundColor: palette.soft, borderColor: palette.accent }} />
  </View>;
}
