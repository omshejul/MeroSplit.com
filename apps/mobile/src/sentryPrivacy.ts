// Keep diagnostic identifiers and timings. Never send record content or credentials.
const segments = new Set('api v1 _allauth app browser auth code request confirm link inspect exchange resume renew google apple challenge token session me groups expenses settlements summary history transactions activity attempts payment-attempts launch cancel reverse payments participants invite invites invitations notifications preferences channels foreground chat chat-conversations attachments versions expense-icons account profile photo avatar uploads media download files sign-in-methods email statements balance-statements bill-email-entry ledger-heads export import pending health ready app-releases simplify leave restore archive opening acknowledge join nickname name upi'.split(' '));
export function diagnosticRoute(value: unknown): string {
  if (typeof value !== 'string') return '/unknown';
  const input = value.replace(/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) /, '');
  if (!input.startsWith('/') && !/^https?:\/\//.test(input)) return '/operation';
  try {
    const url = new URL(input, 'https://merosplit.com');
    if (!['merosplit.com', 'merosplit.omshejul.com'].includes(url.hostname)) return '/external';
    return '/' + url.pathname.split('/').filter(Boolean).slice(0, 14).map(part => segments.has(part) ? part : ':id').join('/');
  } catch { return '/unknown'; }
}
export function scrubBreadcrumb<T extends { category?: string; type?: string; data?: Record<string, unknown>; timestamp?: number }>(crumb: T): T | null {
  const data = crumb.data ?? {}, clean: Record<string, unknown> = {};
  if (crumb.type === 'http' || ['fetch', 'xhr', 'http', 'httplib'].includes(crumb.category ?? '')) {
    clean.url = diagnosticRoute(data.url);
    if (typeof data.method === 'string' && ['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS'].includes(data.method)) clean.method = data.method;
    const status = data.status_code ?? data['http.response.status_code'];
    if (typeof status === 'number' && status >= 100 && status <= 599) clean.status_code = status;
    return { category: 'http', type: 'http', timestamp: crumb.timestamp, data: clean } as T;
  }
  if (crumb.category === 'sync' && ['started','accepted','failed'].includes(String(data.phase))) {
    clean.phase = data.phase;
    if (typeof data.status === 'number' && data.status >= 100 && data.status <= 599) clean.status = data.status;
    if (typeof data.pending_count === 'number' && Number.isSafeInteger(data.pending_count) && data.pending_count >= 0) clean.pending_count = data.pending_count;
    return { category: 'sync', type: 'default', timestamp: crumb.timestamp, data: clean } as T;
  }
  return null;
}
function safeContexts(contexts: any) {
  const fields: Record<string, string[]> = { trace: ['trace_id','span_id','parent_span_id','op','status','origin'], app: ['app_identifier','app_version','app_build','app_start_time'], os: ['name','version','build','kernel_version'], device: ['family','model','model_id','arch','manufacturer','brand','simulator','screen_width_pixels','screen_height_pixels'], browser: ['name','version'], runtime: ['name','version'] };
  return Object.fromEntries(Object.entries(fields).flatMap(([name, keys]) => contexts?.[name] ? [[name, Object.fromEntries(keys.filter(key => ['string','number','boolean'].includes(typeof contexts[name][key])).map(key => [key, contexts[name][key]]))]] : []));
}
export function scrubSentrySpan<T extends Record<string, any>>(span: T): T {
  const clean: Record<string, any> = span;
  clean.description = String(span.op ?? '').startsWith('http') ? diagnosticRoute(span.description) : String(span.op ?? 'operation');
  clean.data = Object.fromEntries(Object.entries(span.data ?? {}).filter(([key, value]) =>
    ['http.status_code','http.response.status_code'].includes(key) && typeof value === 'number'
    || key === 'http.request.method' && ['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS'].includes(String(value))));
  delete clean.tags;
  return span;
}
export function scrubSentryEvent<T extends Record<string, any>>(event: T): T {
  const data: Record<string, any> = event;
  for (const key of ['request','extra','message','logentry','threads','server_name','fingerprint']) delete data[key];
  const id = data.user?.id;
  if (/^[1-9]\d{0,19}$/.test(String(id ?? ''))) data.user = { id: String(id) }; else delete data.user;
  if (data.breadcrumbs) data.breadcrumbs = data.breadcrumbs.map(scrubBreadcrumb).filter(Boolean).slice(-50);
  if (data.transaction) data.transaction = diagnosticRoute(data.transaction);
  if (data.contexts) data.contexts = safeContexts(data.contexts);
  if (data.tags) data.tags = Object.fromEntries(Object.entries(data.tags).filter(([key, value]) =>
    key === 'app.platform' && ['ios','android','web'].includes(String(value))
    || key === 'app.build' && /^\d{1,10}$/.test(String(value))
    || key === 'app.version' && /^[\d.]{1,24}$/.test(String(value))
    || key === 'app.ota_id' && /^(embedded|[a-f0-9-]{36})$/.test(String(value))));
  for (const exception of data.exception?.values ?? []) {
    exception.value = '[redacted]';
    for (const frame of exception.stacktrace?.frames ?? []) for (const key of ['vars','pre_context','context_line','post_context']) delete frame[key];
  }
  for (const span of data.spans ?? []) scrubSentrySpan(span);
  return event;
}
