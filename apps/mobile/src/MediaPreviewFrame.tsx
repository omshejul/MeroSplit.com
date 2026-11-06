import React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { Text } from 'react-native-paper';
import { Button, Icon, radii, useUI } from './ui';

export const mediaPreviewShape = (size: number, borderRadius: number = radii.control) => ({ width: size, height: size, borderRadius });
export default function MediaPreviewFrame({ size = 56, label, text, onRetry, borderRadius, loading = false }: { loading?: boolean; size?: number; label: string; text?: string; onRetry?: () => void; borderRadius?: number }) {
  const { ui, palette } = useUI();
  const style = { ...mediaPreviewShape(size, borderRadius), backgroundColor: palette.soft, alignItems: 'center' as const, justifyContent: 'center' as const };
  const content = loading ? <ActivityIndicator accessibilityLabel={label} color={palette.accent} /> : <>{!onRetry && <Icon name="bill" size={24} color={palette.muted} />}{text && <Text style={ui.caption}>{text}</Text>}</>;
  return onRetry ? <Button kind="plain" accessibilityRole="button" accessibilityLabel={label} onPress={onRetry} style={style}>{content}</Button> : <View accessible accessibilityRole="image" accessibilityLabel={label} style={style}>{content}</View>;
}
