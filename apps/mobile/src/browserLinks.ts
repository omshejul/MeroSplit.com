export type AppLink = { groupInviteToken: string; groupId?: never; expenseId?: never; chat?: never; versions?: never; inviteToken?: never } | { groupId: string; expenseId?: string; chat?: true; versions?: true; inviteToken?: never } | { inviteToken: string; groupId?: never; expenseId?: never; chat?: never };
export function readAppLink(): AppLink | null { return null; }
export function subscribeAppLinks(_callback: (target: AppLink | null) => void): () => void { return () => {}; }
export function writeAppLink(_target: AppLink | null, _options?: { replace?: boolean }): void {}
