// The app supplies its existing lock and live account/navigation guard.
export async function restartForUpdate({ lock, safe, flushWrites, reload }: {
  lock: { current: boolean }; safe: () => boolean; flushWrites: () => Promise<void>; reload: () => Promise<void>;
}): Promise<void> {
  if (lock.current || !safe()) throw new Error("Finish what's in progress, then try again.");
  lock.current = true;
  try {
    await flushWrites();
    if (!safe()) throw new Error("Finish what's in progress, then try again.");
    // Native will replace this JS runtime. Do not unlock or run cleanup on success.
    await reload();
  } catch (error) {
    lock.current = false;
    throw error;
  }
}
