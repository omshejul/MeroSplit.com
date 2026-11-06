import { useLayoutEffect } from 'react';
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import * as Updates from 'expo-updates';
import { configureSyncDiagnostics, configureRequestTracing } from './syncDiagnostics';
import * as Sentry from '@sentry/react-native';
import { scrubSentryEvent, scrubSentrySpan, scrubBreadcrumb, diagnosticRoute } from './sentryPrivacy';

Sentry.init({
  dsn: process.env.EXPO_PUBLIC_SENTRY_DSN,
  enabled: Boolean(process.env.EXPO_PUBLIC_SENTRY_DSN) && !__DEV__,
  environment: process.env.EXPO_PUBLIC_SENTRY_ENVIRONMENT ?? 'production',
  sendDefaultPii: false,
  maxBreadcrumbs: 50,
  beforeBreadcrumb: crumb => scrubBreadcrumb(crumb),
  tracesSampleRate: 1.0,
  tracePropagationTargets: [/^https:\/\/merosplit\.com\/api\/v1(?:\/|$)/],
  enableAutoPerformanceTracing: true,
  enableAppStartTracking: true,
  enableNativeFramesTracking: false,
  beforeSend: scrubSentryEvent,
  beforeSendTransaction: scrubSentryEvent,
  beforeSendSpan: scrubSentrySpan,
});

export { Sentry };

Sentry.setTag('app.platform', Platform.OS);
Sentry.setTag('app.version', Constants.nativeAppVersion ?? '');
Sentry.setTag('app.build', Constants.nativeBuildVersion ?? '');
Sentry.setTag('app.ota_id', Updates.updateId ?? 'embedded');

export function useSentryUser(id: string | null) {
  useLayoutEffect(() => {
    Sentry.setUser(id ? { id } : null);
    return () => {
      Sentry.setUser(null);
      Sentry.getIsolationScope().clearBreadcrumbs();
      Sentry.getCurrentScope().clearBreadcrumbs();
    };
  }, [id]);
}

configureSyncDiagnostics((event, error) => {
  if (Sentry.getIsolationScope().getUser()?.id !== event.userId) return;
  Sentry.addBreadcrumb({ category: 'sync', data: { phase: event.phase, pending_count: event.pending_count, status: event.status } });
  if (event.phase === 'failed') Sentry.withScope(scope => {
    scope.setUser({ id: event.userId });
    Sentry.captureException(error instanceof Error ? error : new Error('Sync failed'));
  });
});

configureRequestTracing((details, task) => Sentry.withScope(scope => {
  scope.setUser({ id: details.userId });
  return Sentry.startSpan({ name: `${details.method} ${diagnosticRoute(details.route)}`, op: 'http.client' }, task);
}));
