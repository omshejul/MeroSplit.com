import React from 'react';
import { View } from 'react-native';
import { Button, useUI } from './ui';

type Props = React.ComponentProps<typeof Button> & { leading?: React.ReactNode; trailing?: React.ReactNode; bodyStyle?: React.ComponentProps<typeof View>['style'] };
export default function ListRow({ leading, trailing, bodyStyle, children, style, onPress, ...props }: Props) {
  const { ui } = useUI();
  const content = <>{leading}<View style={[ui.rowBody, bodyStyle]}>{children}</View>{trailing}</>;
  return onPress ? <Button {...props} kind="plain" onPress={onPress} style={state => [ui.row, typeof style === 'function' ? style(state) : style]}>{content}</Button>
    : <View ref={props.ref} style={[ui.row, typeof style !== 'function' && style]}>{content}</View>;
}
