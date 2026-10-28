import React from 'react';
import { View } from 'react-native';
import { Button } from './ui';
import { ErrorState } from './UIStates';
import type { useScrollPagination } from './useScrollPagination';

type Paging = Pick<ReturnType<typeof useScrollPagination>, 'canLoadMore' | 'loading' | 'failed' | 'loadMore' | 'retry'>;
export default function PaginationFooter({ paging, error = 'Could not load earlier records.', disabled = false, loadingLabel = 'Load older', children, style }: {
  paging: Paging; error?: string; disabled?: boolean; loadingLabel?: string; children?: React.ReactNode; style?: React.ComponentProps<typeof View>['style'];
}) {
  return <View style={[{ paddingVertical: 12, gap: 8 }, style]}>{children}
    {paging.canLoadMore && !paging.failed && <Button title={paging.loading ? loadingLabel : 'Load older'} kind="text" disabled={disabled || paging.loading} onPress={paging.loadMore} />}
    {paging.failed && (error ? <ErrorState error={error} disabled={disabled} onRetry={paging.retry} /> : <Button title="Retry" kind="text" disabled={disabled} onPress={paging.retry} />)}
  </View>;
}
