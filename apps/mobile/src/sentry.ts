import * as Sentry from '@sentry/react-native';
import { scrubSentryEvent } from './sentryPrivacy';

Sentry.init({
  dsn: process.env.EXPO_PUBLIC_SENTRY_DSN,
  enabled: Boolean(process.env.EXPO_PUBLIC_SENTRY_DSN) && !__DEV__,
  environment: process.env.EXPO_PUBLIC_SENTRY_ENVIRONMENT ?? 'production',
  sendDefaultPii: false,
  maxBreadcrumbs: 0,
  tracesSampleRate: 0,
  enableAutoPerformanceTracing: false,
  enableAppStartTracking: false,
  enableNativeFramesTracking: false,
  beforeSend: scrubSentryEvent,
});

export { Sentry };
