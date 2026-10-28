import React from 'react';
import { View } from 'react-native';
import { RowDividerContext } from './rowDividers';

// Flatten fragments as well as arrays, retaining stable keys for editable rows.
export function groupRows(children: React.ReactNode, prefix = ''): { key: string; child: React.ReactNode }[] {
  return React.Children.toArray(children).flatMap((child, index) => {
    const key = `${prefix}${React.isValidElement(child) ? child.key ?? index : index}`;
    return React.isValidElement<{ children?: React.ReactNode }>(child) && child.type === React.Fragment
      ? groupRows(child.props.children, `${key}/`) : [{ key, child }];
  });
}
export default function RowGroup({ children, ...view }: React.ComponentProps<typeof View>) {
  const rows = groupRows(children);
  return <View {...view}>{rows.map(({ key, child }, index) => <RowDividerContext.Provider key={key} value={index < rows.length - 1}>{child}</RowDividerContext.Provider>)}</View>;
}
