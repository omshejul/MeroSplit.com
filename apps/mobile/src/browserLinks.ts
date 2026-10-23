export type AppLink = { groupId: string; expenseId?: string; inviteToken?: never } | { inviteToken: string; groupId?: never; expenseId?: never };
export function readAppLink(): AppLink | null { return null; }
export function subscribeAppLinks(_callback: (target: AppLink | null) => void): () => void { return () => {}; }
export function writeAppLink(_target: AppLink | null, _options?: { replace?: boolean }): void {}
