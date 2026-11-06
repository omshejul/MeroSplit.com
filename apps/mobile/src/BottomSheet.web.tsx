// shadcn's Base UI Drawer composition, styled with the existing app tokens.
// https://ui.shadcn.com/docs/components/base/drawer (MIT), adapted 2026-11-01.
import React, { useEffect, useState } from 'react';
import { Drawer } from '@base-ui/react/drawer';
import RowGroup from './RowGroup';
import LoadingOverlay from './LoadingOverlay';
import { useDialogRegistration } from './DialogFocus';
import { appFontFamily } from './typography';
import { Button, Icon, useUI } from './ui';
import type NativeBottomSheet from './BottomSheet';
import './bottomSheet.css';

const snapPoints = [0.65, 1];
export default function BottomSheet({ visible, onDismiss, title, icon, total, count, disabled, doneAccessibilityLabel, gap = 0, closeIconOnly = false, children }: React.ComponentProps<typeof NativeBottomSheet>) {
  const { palette, motion } = useUI();
  const [snapPoint, setSnapPoint] = useState<Drawer.Root.SnapPoint | null>(snapPoints[0]);
  useDialogRegistration(visible);
  useEffect(() => { if (!visible) setSnapPoint(snapPoints[0]); }, [visible]);
  const close = () => { if (!disabled) onDismiss(); };
  return <Drawer.Root open={visible} onOpenChange={(open, event) => { if (disabled) event.cancel(); else if (!open) close(); }} disablePointerDismissal={disabled} snapPoints={snapPoints} snapPoint={snapPoint} onSnapPointChange={setSnapPoint}>
    <Drawer.VirtualKeyboardProvider><Drawer.Portal>
      <Drawer.Backdrop className="mero-sheet-overlay" data-motion={motion.enabled ? 'on' : 'off'} />
      <Drawer.Viewport className="mero-sheet-viewport">
        <Drawer.Popup className="mero-sheet-popup" data-motion={motion.enabled ? 'on' : 'off'} style={{ backgroundColor: palette.surface, color: palette.text, fontFamily: appFontFamily, '--sheet-outline': palette.outline, '--sheet-accent': palette.accent } as React.CSSProperties}>
          <header className="mero-sheet-header">
            <div className="mero-sheet-handle" role="separator" tabIndex={0} aria-label="Resize sheet" aria-orientation="horizontal" aria-valuemin={65} aria-valuemax={100} aria-valuenow={snapPoint === 1 ? 100 : 65} onKeyDown={event => { if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) { event.preventDefault(); setSnapPoint(event.key === 'ArrowUp' || event.key === 'End' ? 1 : snapPoints[0]); } }}><span /></div>
            <div className="mero-sheet-heading"><Icon name={icon} /><Drawer.Title className="mero-sheet-title">{title}</Drawer.Title><Button title={closeIconOnly ? undefined : "Done"} icon={closeIconOnly ? "close" : "tick"} iconOnly={closeIconOnly} kind={closeIconOnly ? "text" : "outlined"} compact accessibilityLabel={doneAccessibilityLabel ?? (icon === 'people' ? 'Apply split' : icon === 'pay' ? 'Apply payers' : 'Close sheet')} disabled={disabled || !closeIconOnly && count === 0} style={closeIconOnly ? { width: 44, height: 44, minWidth: 44 } : undefined} onPress={close} /></div>
            {(total || count !== undefined) && <p className="mero-sheet-summary" style={{ color: palette.muted }}>{[total, count === undefined ? '' : `${count} selected`].filter(Boolean).join(' · ')}</p>}
          </header>
          <Drawer.Content className="mero-sheet-body"><RowGroup style={{ gap }}>{children}</RowGroup></Drawer.Content>
          <LoadingOverlay inline />
        </Drawer.Popup>
      </Drawer.Viewport>
    </Drawer.Portal></Drawer.VirtualKeyboardProvider>
  </Drawer.Root>;
}
