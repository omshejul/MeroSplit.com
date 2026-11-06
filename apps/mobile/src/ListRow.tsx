import { StyleSheet } from 'react-native';
import { useRowDivider } from './rowDividers';
import React from 'react';
import { View } from 'react-native';
import { Button, useUI } from './ui';

type Props = React.ComponentProps<typeof Button> & { divider?: boolean; leading?: React.ReactNode; trailing?: React.ReactNode; bodyStyle?: React.ComponentProps<typeof View>['style'] };
export default function ListRow({ leading, trailing, bodyStyle, children, style, onPress, divider, ...props }: Props) {
  const { ui } = useUI();
  const border = { borderBottomWidth: useRowDivider(divider) ? StyleSheet.hairlineWidth : 0 };
  const content = <>{leading}<View style={[ui.rowBody, bodyStyle]}>{children}</View>{trailing}</>;
  return onPress ? <Button {...props} kind="plain" onPress={onPress} style={state => [ui.row, typeof style === 'function' ? style(state) : style, border]}>{content}</Button>
    : <View {...props} style={[ui.row, typeof style !== 'function' && style, border]}>{content}</View>;
}
