import React from 'react';
import { View } from 'react-native';
import { AmountText, SectionHeading, useUI } from './ui';
export default function BillSummary({ title, heading, leading, amount, amountColor, children, style, trailing, prominent = false }: {
  trailing?: React.ReactNode; prominent?: boolean; title: string; heading?: React.ReactNode; leading?: React.ReactNode; amount: string; amountColor?: string; children?: React.ReactNode; style?: React.ComponentProps<typeof View>['style'];
}) {
  const { ui } = useUI();
  const headingContent = <View style={{ flexDirection: 'row', alignItems: prominent ? 'flex-start' : 'center', gap: prominent ? 10 : 8 }}>{leading}{heading ?? <SectionHeading>{title}</SectionHeading>}</View>;
  const amountContent = <AmountText amount={amount} style={[ui.numeric, { textAlign: 'left' }, prominent && { fontSize: 34, lineHeight: 40 }, amountColor && { color: amountColor }]} />;
  return <View style={[{ gap: prominent ? 2 : 4, paddingVertical: 8 }, style]}>
    {trailing ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 12 }}><View style={{ flex: 1, minWidth: 180, gap: prominent ? 2 : 4 }}>{headingContent}{amountContent}</View><View style={{ marginLeft: 'auto' }}>{trailing}</View></View> : <>{headingContent}{amountContent}</>}
    {prominent ? <View style={{ gap: 4, marginTop: 10 }}>{children}</View> : children}
  </View>;
}
