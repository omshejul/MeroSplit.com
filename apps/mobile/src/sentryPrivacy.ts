// Stack locations identify failures. User content and network history do not.
export function scrubSentryEvent<T extends {
  exception?: { values?: Array<{ value?: string; stacktrace?: { frames?: Array<{
    vars?: unknown; pre_context?: unknown; context_line?: unknown; post_context?: unknown;
  }> } }> };
}>(event: T): T {
  for (const key of ['request', 'user', 'extra', 'breadcrumbs', 'message', 'logentry', 'transaction', 'threads']) {
    delete (event as Record<string, unknown>)[key];
  }
  for (const exception of event.exception?.values ?? []) {
    exception.value = '[redacted]';
    for (const frame of exception.stacktrace?.frames ?? []) {
      delete frame.vars;
      delete frame.pre_context;
      delete frame.context_line;
      delete frame.post_context;
    }
  }
  return event;
}
