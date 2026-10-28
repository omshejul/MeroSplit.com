import React from 'react';
import { View } from 'react-native';
import { Text } from 'react-native-paper';
import { Button, ErrorText, useUI } from './ui';
import LoadingSpinner from './LoadingSpinner';

type ViewStyle = React.ComponentProps<typeof View>['style'];
export function NoticeBanner({ tone, style, ...props }: React.ComponentProps<typeof Text> & { tone?: 'success' | 'warning' | 'error' }) {
  const { ui } = useUI();
  return <Text accessibilityLiveRegion="polite" accessibilityRole={tone === 'error' ? 'alert' : undefined} {...props} style={[ui.notice, tone && ui[tone], style]} />;
}
export function ErrorState({ error, onRetry, retryLabel = 'Retry', disabled = false, retryAccessibilityLabel, style }: { error: string; onRetry?: () => void; retryLabel?: string; retryAccessibilityLabel?: string; disabled?: boolean; style?: ViewStyle }) {
  return <View style={[{ gap: 12 }, style]}><ErrorText live>{error}</ErrorText>{onRetry && <Button title={retryLabel} accessibilityLabel={retryAccessibilityLabel ?? retryLabel} kind="text" disabled={disabled} onPress={onRetry} />}</View>;
}
export function EmptyState({ message, illustration, style }: { message: string; illustration?: React.ReactNode; style?: ViewStyle }) {
  const { ui } = useUI();
  return <View style={[{ gap: 10 }, style]}>{illustration}<Text accessibilityLiveRegion="polite" style={ui.caption}>{message}</Text></View>;
}
export function LoadingState({ label, spinner = false, style }: { label: string; spinner?: boolean; style?: ViewStyle }) {
  const { ui } = useUI();
  return <View style={[{ gap: 8 }, style]}>{spinner && <LoadingSpinner visible label={label} />}<Text accessibilityLiveRegion="polite" style={ui.caption}>{label}</Text></View>;
}
