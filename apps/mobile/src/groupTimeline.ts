import type { Group, GroupTransaction } from './types';

/** Complete caches follow the server timeline's date, creation, kind and ID order. */
export function cachedTimeline(group: Group, query = ''): GroupTransaction[] {
  const search = query.trim().toLowerCase();
  const rows: GroupTransaction[] = [
    ...group.expenses.filter(bill => !search || `${bill.description} ${bill.notes ?? ''}`.toLowerCase().includes(search))
      .map(bill => ({ kind: 'bill' as const, date: bill.date, bill })),
    ...(!search ? group.settlements.map(payment => ({ kind: 'payment' as const, date: payment.date ?? null, payment })) : []),
  ];
  const key = (row: GroupTransaction) => {
    const record = row.kind === 'bill' ? row.bill : row.payment;
    const pending = row.kind === 'bill' ? row.bill.version === 0 : row.payment.provenance === 'pending_manual';
    const created = record.created_at?.replace('+00:00', 'Z').replace(/(\.\d+)?Z$/, (_match, fraction) => (fraction ?? '.').padEnd(7, '0') + 'Z') ?? (pending ? '~' : '');
    return `${row.date ? 1 : 0}|${row.date ?? ''}|${created}|${row.kind === 'payment' ? 1 : 0}|${record.id}`;
  };
  return rows.map(row => ({ row, key: key(row) })).sort((a, b) => a.key < b.key ? 1 : a.key > b.key ? -1 : 0).map(value => value.row);
}
