import React from 'react';
import { View } from 'react-native';
import { AmountText, SectionHeading, useUI } from './ui';
export default function BillSummary({ title, heading, leading, amount, amountColor, children, style }: {
  title: string; heading?: React.ReactNode; leading?: React.ReactNode; amount: string; amountColor?: string; children?: React.ReactNode; style?: React.ComponentProps<typeof View>['style'];
}) {
  const { ui } = useUI();
  return <View style={[{ gap: 4, paddingVertical: 8 }, style]}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>{leading}{heading ?? <SectionHeading>{title}</SectionHeading>}</View>
    <AmountText amount={amount} style={[ui.numeric, { textAlign: 'left' }, amountColor && { color: amountColor }]} />{children}
  </View>;
}
