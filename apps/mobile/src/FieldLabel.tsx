import React from 'react';
import { Text } from 'react-native-paper';

export default function FieldLabel({ nativeID: _id, ...props }: React.ComponentProps<typeof Text>) {
  return <Text {...props} />;
}
