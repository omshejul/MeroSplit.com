export type SettingState<T> = { value: T; saving: boolean; error: string };

// One write at a time; a completion can confirm only the intent it actually sent.
export function createSettingWriter<T>(initial: T, save: (value: T) => Promise<T>, publish: (state: SettingState<T>) => void, equal: (a: T, b: T) => boolean = Object.is) {
  let confirmed = initial, wanted = initial, retryValue = initial, revision = 0, settled = 0, running = false;
  let snapshot: SettingState<T> = { value: initial, saving: false, error: '' };
  const emit = (value: T, saving: boolean, error = '') => { snapshot = { value, saving, error }; publish(snapshot); };
  async function drain() {
    if (running) return;
    running = true;
    while (settled < revision) {
      const stamp = revision, value = wanted;
      try {
        const saved = await save(value); confirmed = saved; settled = stamp;
        if (stamp === revision) { wanted = saved; emit(saved, false); }
      } catch {
        settled = stamp;
        if (stamp === revision) { retryValue = value; wanted = confirmed; emit(confirmed, false, 'Could not save. Try again.'); }
      }
    }
    running = false;
  }
  function change(value: T) {
    if (equal(value, wanted) && !snapshot.error) return;
    wanted = value; retryValue = value; ++revision; emit(value, true); void drain();
  }
  return {
    get snapshot() { return snapshot; },
    change,
    retry: () => change(retryValue),
    hydrate(value: T) { if (snapshot.saving || snapshot.error) return; confirmed = wanted = value; emit(value, false); },
  };
}
