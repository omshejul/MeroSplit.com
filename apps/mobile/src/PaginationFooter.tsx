import { useLoading } from './LoadingOverlay';
import React from 'react';
import { View } from 'react-native';
import LoadingSpinner from './LoadingSpinner';
import { Button } from './ui';
import { ErrorState } from './UIStates';
import type { useScrollPagination } from './useScrollPagination';

type Paging = Pick<ReturnType<typeof useScrollPagination>, 'canLoadMore' | 'loading' | 'failed' | 'loadMore' | 'retry'>;
export default function PaginationFooter({ paging, automatic = false, error = 'Could not load earlier records.', disabled = false, loadingLabel = 'Load older', children, style }: {
  paging: Paging; automatic?: boolean; error?: string; disabled?: boolean; loadingLabel?: string; children?: React.ReactNode; style?: React.ComponentProps<typeof View>['style'];
}) {
  useLoading(!automatic && paging.loading);
  if (automatic && !paging.loading && !paging.failed && !children) return null;
  return <View style={[{ paddingVertical: 12, gap: 8 }, style]}>{children}
    {automatic && paging.loading && <LoadingSpinner visible label="Loading older records" />}
    {!automatic && paging.canLoadMore && !paging.failed && <Button title={paging.loading ? loadingLabel : 'Load older'} kind="text" disabled={disabled || paging.loading} onPress={paging.loadMore} />}
    {paging.failed && (error ? <ErrorState error={error} disabled={disabled} onRetry={paging.retry} /> : <Button title="Retry" kind="text" disabled={disabled} onPress={paging.retry} />)}
  </View>;
}
