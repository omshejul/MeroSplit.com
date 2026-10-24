import React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
export type FormProps = { children: React.ReactNode; label: string; onSubmit: () => void; style?: StyleProp<ViewStyle> };
export default function Form({ children, style }: FormProps) {
  return style ? <View style={style}>{children}</View> : <>{children}</>;
}
