import React, { useEffect, useRef, useState } from 'react';
import { FlatList, StyleSheet, View } from 'react-native';
import { Text } from 'react-native-paper';
import { accountOwner, ApiError, request } from './api';
import { Button, ErrorText, useUI } from './ui';
import LoadingSpinner from './LoadingSpinner';
import { pageContentStyle } from './AppNavigation';
import { useScrollPagination } from './useScrollPagination';
import { historyActions, historyLabels, historyTime, historyValue } from './expenseHistory';
import type { ExpenseHistoryPage, ExpenseVersion, VersionChange } from './expenseHistory';
import type { Session } from './types';

type Row = { version: ExpenseVersion; change?: VersionChange };
export function VersionHistoryRow({ version, change, now }: Row & { now?: number }) {
  const { ui, palette } = useUI();
  const actor = version.actor_name || 'Unknown person', time = historyTime(version.created_at, now);
  const say = change ? historyActions[change.field] || 'changed the expense' : 'created the expense';
  const value = (field: string, raw: unknown) => historyValue(field, raw, version.names, version.currency);
  const old = change && value(change.field, change.before), next = change && value(change.field, change.after);
  return <View style={[styles.row, { borderBottomColor: palette.line }]}>
    <View style={styles.heading}>
      <Text style={[ui.body, styles.sentence]}><Text style={{ fontWeight: '600' }}>{actor}</Text> {say}</Text>
      {version.via_mcp === true && <Text style={[ui.caption, { fontSize: 12, lineHeight: 17 }]}>via MCP</Text>}
      <Text accessibilityLabel={new Date(version.created_at).toLocaleString()} style={ui.caption}>{time}</Text>
    </View>
    {change ? <View accessible accessibilityLabel={`From ${old}. To ${next}.`} style={styles.values}>
      <Text selectable style={[ui.body, styles.old, { color: palette.muted }]}>{old}</Text>
      <Text accessible={false} style={ui.caption}>→</Text>
      <Text selectable style={[ui.body, styles.value, { fontWeight: '600' }]}>{next}</Text>
    </View> : <View style={styles.creation}>
      {version.changes.map(field => <View key={field.field} style={styles.cell}>
        <Text style={ui.caption}>{historyLabels[field.field]}</Text>
        <Text selectable style={ui.body}>{value(field.field, field.after)}</Text>
      </View>)}
    </View>}
  </View>;
}

export default function ExpenseVersionHistory({ session, groupId, expenseId, title, active, online }: {
  session: Session; groupId: string; expenseId: string; title: string; active: boolean; online: boolean;
}) {
  const { ui } = useUI(), path = `/groups/${groupId}/expenses/${expenseId}/versions`;
  const scope = `${accountOwner(session)}|${session.token}|${path}`;
  const current = useRef(scope); current.current = scope;
  const [page, setPage] = useState<(ExpenseHistoryPage & { scope: string }) | null>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, [active]);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [retry, setRetry] = useState(0);
  const controller = useRef<AbortController | null>(null), mounted = useRef(false), allowed = useRef(active && online);
  allowed.current = active && online;
  const shown = active && online && page?.scope === scope ? page : null;
  const list = useRef<FlatList<Row>>(null);
  async function load(before?: number, signal?: AbortSignal) {
    if (!allowed.current) return false;
    controller.current?.abort();
    const read = new AbortController(); controller.current = read;
    if (!before) setBusy(true); setError('');
    const abort = () => read.abort(); signal?.addEventListener('abort', abort, { once: true });
    try {
      const result = await request(session, path + (before ? `?before=${before}&limit=20` : '?limit=20'), 'GET', undefined, 'json', read.signal) as ExpenseHistoryPage;
      if (!mounted.current || read.signal.aborted || current.current !== scope || !allowed.current) return false;
      if (before && page?.scope === scope && result.version !== page.version) throw new ApiError(409, 'History changed. Refresh to see the latest.');
      if (result.group_id !== groupId || result.expense_id !== expenseId) throw new Error('This history is unavailable.');
      const added = before && page?.scope === scope ? result.items.filter(item => !page.items.some(old => old.id === item.id)) : result.items;
      setPage(previous => ({ ...result, scope, items: before && previous?.scope === scope ? [...previous.items, ...result.items.filter(item => !previous.items.some(old => old.id === item.id))] : result.items,
        legacy_gap: result.legacy_gap || !!(before && previous?.scope === scope && previous.legacy_gap) }));
      return added.length > 0;
    } catch (cause) {
      if (!mounted.current || read.signal.aborted || current.current !== scope || !allowed.current) return false;
      if (before && !(cause instanceof ApiError && [401, 403, 404, 409].includes(cause.status))) throw cause;
      setPage(null);
      setError(cause instanceof ApiError && cause.status === 409 ? 'History changed. Refresh to see the latest.' : cause instanceof ApiError && [401, 403, 404].includes(cause.status) ? 'This history is no longer available.' : 'Could not load version history. Try again.');
      if (before) throw cause;
    } finally {
      signal?.removeEventListener('abort', abort);
      if (mounted.current && !read.signal.aborted && current.current === scope) setBusy(false);
    }
  }
  useEffect(() => {
    mounted.current = true; setPage(null); setError('');
    if (active && online) void load();
    return () => { mounted.current = false; controller.current?.abort(); };
  }, [scope, active, online, retry]);
  const paging = useScrollPagination({ scope, cursor: shown?.next_before, enabled: active && online && !error, scrollRef: list, load: signal => load(shown?.next_before ?? undefined, signal).then(Boolean) });
  if (!active) return null;
  const rows: Row[] = shown?.items.flatMap(version => version.kind === 'created' ? [{ version }] : version.changes.map(change => ({ version, change }))) ?? [];
  return <FlatList ref={list} {...paging.events} scrollEventThrottle={100} onEndReachedThreshold={0.3} data={rows} keyExtractor={({ version, change }) => `${version.id}:${change?.field || 'created'}`}
    renderItem={({ item }) => <VersionHistoryRow {...item} now={now} />} contentContainerStyle={[pageContentStyle, { gap: 0 }]}
    ListHeaderComponent={<View style={styles.subtitle}><Text style={ui.body}>{title}</Text></View>}
    ListEmptyComponent={!online ? <Text style={ui.body}>Go online to view version history.</Text> : error ? <View style={styles.status}><ErrorText live>{error}</ErrorText><Button title="Retry" onPress={() => setRetry(value => value + 1)} /></View>
      : busy || !shown ? <LoadingSpinner visible /> : <Text style={ui.body}>{shown.next_before ? 'No recorded changes on this page.' : 'No version history was recorded.'}</Text>}
    ListFooterComponent={<View style={styles.status}>
      {shown?.legacy_gap && rows.length > 0 && <Text style={ui.caption}>Some earlier details weren’t recorded.</Text>}
      {paging.loading && <LoadingSpinner visible />}
      {paging.failed && shown && <><ErrorText live>Could not load earlier changes.</ErrorText><Button title="Retry" kind="text" onPress={paging.retry} /></>}
    </View>} />;
}
const styles = StyleSheet.create({
  subtitle: { paddingBottom: 18 },
  row: { paddingVertical: 16, gap: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  heading: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', gap: 8 }, sentence: { flexGrow: 1, flexShrink: 1 },
  values: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-start', columnGap: 10, rowGap: 6 },
  old: { textDecorationLine: 'line-through', flexShrink: 1 }, value: { flexShrink: 1 },
  creation: { flexDirection: 'row', flexWrap: 'wrap', gap: 14 }, cell: { flexGrow: 1, flexBasis: '45%', minWidth: 120, gap: 3 },
  status: { gap: 12, paddingVertical: 14 },
});
