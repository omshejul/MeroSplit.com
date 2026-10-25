import * as SecureStore from 'expo-secure-store';
const key = 'merosplit.pendingGroupInvite';
let writes: Promise<void> = Promise.resolve();
export async function savedGroupInvite(): Promise<string | null> { await writes; return SecureStore.getItemAsync(key); }
export function saveGroupInvite(token: string | null): Promise<void> {
  const result = writes.then(() => token ? SecureStore.setItemAsync(key, token) : SecureStore.deleteItemAsync(key));
  writes = result.catch(() => {}); return result;
}
