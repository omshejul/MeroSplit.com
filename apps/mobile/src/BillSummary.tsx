import React from 'react';
import { View } from 'react-native';
import { AmountText, SectionHeading, useUI } from './ui';
export default function BillSummary({ title, heading, leading, amount, amountColor, children, style, prominent = false }: {
  prominent?: boolean; title: string; heading?: React.ReactNode; leading?: React.ReactNode; amount: string; amountColor?: string; children?: React.ReactNode; style?: React.ComponentProps<typeof View>['style'];
}) {
  const { ui } = useUI();
  return <View style={[{ gap: prominent ? 2 : 4, paddingVertical: 8 }, style]}>
    <View style={{ flexDirection: 'row', alignItems: prominent ? 'flex-start' : 'center', gap: prominent ? 10 : 8 }}>{leading}{heading ?? <SectionHeading>{title}</SectionHeading>}</View>
    <AmountText amount={amount} style={[ui.numeric, { textAlign: 'left' }, prominent && { fontSize: 34, lineHeight: 40 }, amountColor && { color: amountColor }]} />{prominent ? <View style={{ gap: 4, marginTop: 10 }}>{children}</View> : children}
  </View>;
}
