import React, { useContext, useEffect, useRef } from 'react';
import { StyleSheet, TextInput } from 'react-native';
import { KeyboardVisibility } from './KeyboardScrollView';

// All field variants inherit focus tracking. The nearest scroller owns movement,
// including in portals and sheets; caller refs and callbacks retain their behavior.
export default function KeyboardInput({ ref, onFocus, onBlur, onLayout, onContentSizeChange, onSelectionChange, ...props }: React.ComponentPropsWithRef<typeof TextInput>) {
  const input = useRef<React.ComponentRef<typeof TextInput>>(null), visibility = useContext(KeyboardVisibility);
  React.useImperativeHandle(ref, () => input.current!, []);
  const blur = visibility?.blur;
  useEffect(() => { const node = input.current; return () => { if (node) blur?.(node); }; }, [blur]);
  const maximum = StyleSheet.flatten(props.style)?.maxHeight;
  return <TextInput {...props} ref={input}
    style={[props.style, props.multiline && visibility?.inputHeight !== undefined && { maxHeight: Math.min(typeof maximum === 'number' ? maximum : Infinity, visibility.inputHeight) }]}
    onFocus={event => { onFocus?.(event); if (input.current) visibility?.focus(input.current); }}
    onBlur={event => { if (input.current) visibility?.blur(input.current); onBlur?.(event); }}
    onLayout={event => { onLayout?.(event); if (input.current?.isFocused()) visibility?.changed(); }}
    onContentSizeChange={event => { onContentSizeChange?.(event); if (input.current?.isFocused()) visibility?.changed(); }}
    onSelectionChange={event => { onSelectionChange?.(event); if (input.current?.isFocused()) visibility?.changed(); }} />;
}
