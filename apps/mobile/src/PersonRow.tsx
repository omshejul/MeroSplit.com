import React from 'react';
import { Text } from 'react-native-paper';
import type { ProfilePhoto } from './types';
import { Avatar, AmountText, useUI } from './ui';
import ListRow from './ListRow';

type Props = React.ComponentProps<typeof ListRow> & { name: string; photo?: ProfilePhoto | null; title?: string; avatar?: boolean; titleStyle?: React.ComponentProps<typeof Text>['style'] };
export default function PersonRow({ name, photo, title = name, avatar = true, titleStyle, children, ...props }: Props) {
  const { ui } = useUI();
  return <ListRow leading={avatar ? <Avatar name={name} photo={photo} /> : undefined} {...props}>
    <Text accessibilityLabel={title} style={[ui.rowTitle, titleStyle]}>{title}</Text>{children}
  </ListRow>;
}
export function PersonAmountRow({ amount, amountLabel, amountStyle, ...props }: Props & { amount?: string; amountLabel?: string; amountStyle?: React.ComponentProps<typeof Text>['style'] }) {
  const { ui } = useUI();
  return <PersonRow {...props} trailing={amountLabel !== undefined ? <Text style={[ui.amount, amountStyle]}>{amountLabel}</Text> : <AmountText amount={amount ?? '0'} style={amountStyle} />} />;
}
