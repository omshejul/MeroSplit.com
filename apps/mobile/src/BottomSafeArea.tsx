import React, { useEffect, useState } from 'react';
import { Keyboard, Platform, type KeyboardEvent } from 'react-native';
import { SafeAreaView, type SafeAreaViewProps } from 'react-native-safe-area-context';

// Once the keyboard covers the home indicator, only the control's normal margin remains.
export default function BottomSafeArea(props: Omit<SafeAreaViewProps, 'edges'>) {
  const [keyboard, setKeyboard] = useState(() => Platform.OS === 'ios' && !!Keyboard.isVisible?.());
  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    const update = (visible: boolean, event: KeyboardEvent) => {
      Keyboard.scheduleLayoutAnimation(event);
      setKeyboard(visible);
    };
    const show = Keyboard.addListener('keyboardWillShow', event => update(event.endCoordinates.height > 0, event));
    const hide = Keyboard.addListener('keyboardWillHide', event => update(false, event));
    return () => { show.remove(); hide.remove(); };
  }, []);
  return <SafeAreaView {...props} edges={Platform.OS === 'ios' && !keyboard ? ['bottom'] : []} />;
}
