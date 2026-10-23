import type { CachedGroup } from './types';

// Display-only partition: callers retain the complete canonical cache and People list.
export function groupListRows(rows: CachedGroup[], archived = false): CachedGroup[] {
  return rows.filter(row => !row.group.is_direct && !!row.group.archived === archived);
}
