import { accountOwner, ApiError, request } from './api.ts';
import type { Database } from './storage.ts';
import type { Session } from './types.ts';
import type { PickedMedia } from './media.ts';
import { mediaBase64 } from './mediaPlatform.ts';

export async function portableExport(db: Database, session: Session, online: boolean, send: typeof request = request, readFile = mediaBase64) {
  const owner = accountOwner(session);
  async function snapshot(tx: Database, scope: string) {
    return {
      groups: await tx.getAllAsync<{ id: string; kind: string; snapshot: string }>('SELECT id,kind,snapshot FROM groups_cache WHERE owner=? ORDER BY id', scope),
      summaries: await tx.getAllAsync<{ id: string; kind: string; snapshot: string }>('SELECT id,kind,snapshot FROM group_summaries WHERE owner=? ORDER BY id', scope),
      pending_commands: await tx.getAllAsync<Record<string, unknown>>('SELECT command_id,group_id,base_version,method,path,body,state,error FROM outbox WHERE owner=? ORDER BY ordinal', scope),
      drafts: await tx.getAllAsync<{ group_id: string; body: string }>('SELECT group_id,body FROM drafts WHERE owner=? ORDER BY group_id', scope),
    };
  }
  let local!: Awaited<ReturnType<typeof snapshot>>, unclaimed!: Awaited<ReturnType<typeof snapshot>>;
  await db.withExclusiveTransactionAsync(async tx => { local = await snapshot(tx, owner); unclaimed = await snapshot(tx, 'local'); });
  const drafts = local.drafts.map(row => ({ id: row.group_id, data: JSON.parse(row.body) as unknown }));
  const files = new Map<string, PickedMedia>();
  function collect(value: unknown) {
    if (!value || typeof value !== 'object') return;
    const candidate = value as PickedMedia;
    if (typeof candidate.uri === 'string' && typeof candidate.name === 'string' && typeof candidate.type === 'string' && Number.isSafeInteger(candidate.size) && candidate.size > 0) { files.set(candidate.uri, candidate); return; }
    for (const child of Object.values(value)) collect(child);
  }
  drafts.forEach(row => collect(row.data));
  unclaimed.drafts.forEach(row => collect(JSON.parse(row.body)));
  if ([...files.values()].reduce((size, file) => size + file.size, 0) > 40 * 1_048_576) throw new Error('Pending files exceed the 40 MB export limit. Sync some files, then export again. Your saved work is kept.');
  const pendingFiles = [];
  for (const file of files.values()) {
    let data: string;
    try { data = await readFile(file); } catch { throw new Error(`Could not export ${file.name}. The export was cancelled and your saved work is kept.`); }
    const bytes = data.length * 3 / 4 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data) || bytes !== file.size) throw new Error(`Could not read all of ${file.name}. Your saved work is kept.`);
    pendingFiles.push({ local_uri: file.uri, name: file.name, content_type: file.type, size: file.size, data_base64: data });
  }
  let account: unknown = null, status = online ? 'unavailable_connection' : 'unavailable_offline';
  if (online) {
    try { account = await send(session, '/account/export'); status = 'included'; }
    catch (error) { if (error instanceof ApiError && error.status < 500) throw error; }
  }
  return { format: 'merosplit-portable-export', version: 1, exported_at: new Date().toISOString(), account_data_status: status, account_data: account,
    limitations: ['Synced file entries contain metadata. Pending local files include their bytes.', ...(status === 'included' ? [] : ['Server account history could not be fetched. This file includes only work saved on this device.'])],
    unclaimed_device_work: { ...unclaimed, groups: unclaimed.groups.map(row => ({ ...row, snapshot: JSON.parse(row.snapshot) })), summaries: unclaimed.summaries.map(row => ({ ...row, snapshot: JSON.parse(row.snapshot) })), drafts: unclaimed.drafts.map(row => ({ id: row.group_id, data: JSON.parse(row.body) })), pending_commands: unclaimed.pending_commands.map(row => ({ ...row, body: JSON.parse(String(row.body)) })) },
    saved_work: { groups: local.groups.map(row => ({ id: row.id, kind: row.kind, data: JSON.parse(row.snapshot) })), summaries: local.summaries.map(row => ({ id: row.id, kind: row.kind, data: JSON.parse(row.snapshot) })), pending_commands: local.pending_commands.map(row => ({ ...row, body: JSON.parse(String(row.body)) })), drafts, pending_files: pendingFiles } };
}
