import { useEffect, type RefObject } from 'react';
import { animate } from 'framer-motion';
import { useUI } from './ui';

export function useDialogMotion(body: RefObject<unknown>, active: boolean) {
  const { motion } = useUI();
  useEffect(() => {
    if (!active || !motion.enabled || !(body.current instanceof HTMLElement)) return;
    const animation = animate(body.current, { opacity: [0.35, 1], transform: ['translateY(20px) scale(0.96)', 'translateY(0px) scale(1)'] }, { duration: 0.2, ease: 'easeOut' });
    return () => animation.cancel();
  }, [active, motion.enabled, body]);
}
