import React, { useEffect, useRef } from 'react';
import { animate } from 'framer-motion';
import { useUI } from './ui';

export default function SceneTransition({ children, changeKey, active }: { children: React.ReactNode; changeKey: string; active: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const { motion } = useUI();
  useEffect(() => {
    if (!active || !motion.enabled || !ref.current) return;
    const animation = animate(ref.current, { opacity: [0.45, 1], transform: ['translateY(16px)', 'translateY(0px)'] }, { duration: 0.2, ease: 'easeOut' });
    return () => animation.cancel();
  }, [changeKey, active, motion.enabled]);
  // Keep the existing form mounted. Animation never resets a draft or scroll view.
  return <div ref={ref} data-scene-transition="" style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, minWidth: 0 }}>{children}</div>;
}
