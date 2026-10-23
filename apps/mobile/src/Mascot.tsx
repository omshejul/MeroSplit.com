import React, { useEffect, useState } from 'react';
import { Image, Keyboard, View, useWindowDimensions } from 'react-native';

export default function Mascot({ size, children }: { size: 'welcome' | 'empty'; children?: React.ReactNode }) {
  const { height } = useWindowDimensions();
  const [keyboardVisible, setKeyboardVisible] = useState(() => Keyboard.isVisible());
  useEffect(() => {
    const shown = Keyboard.addListener('keyboardDidShow', () => setKeyboardVisible(true));
    const hidden = Keyboard.addListener('keyboardDidHide', () => setKeyboardVisible(false));
    return () => { shown.remove(); hidden.remove(); };
  }, []);
  if (height < 600 || keyboardVisible) return children ? <>{children}</> : null;
  const side = size === 'welcome' ? 112 : 80;
  const image = <Image source={require('../assets/mascot.png')} resizeMode="contain" alt="" accessible={false}
    accessibilityElementsHidden importantForAccessibility="no-hide-descendants" focusable={false}
    style={{ width: side, height: side, alignSelf: 'center' }} />;
  return children ? <>{image}<View style={{ alignItems: 'center' }}>{children}</View></> : image;
}
