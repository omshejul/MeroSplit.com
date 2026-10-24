import { useCallback, useEffect, useRef, useState } from 'react';

// One local display preference. A choice made before the saved value finishes
// loading wins, and writes run in order so an older choice cannot land last.
export function useSavedChoice<T>(initial: T, read: () => Promise<T>, write: (value: T) => Promise<void>, apply?: (value: T) => void) {
  const [value, setValue] = useState<T>(initial);
  const revision = useRef(0), writes = useRef(Promise.resolve());
  useEffect(() => {
    let mounted = true;
    const initialRevision = revision.current;
    void read().then(saved => {
      if (!mounted || revision.current !== initialRevision) return;
      setValue(saved); apply?.(saved);
    }).catch(() => {});
    return () => { mounted = false; };
  }, []);
  const change = useCallback(async (next: T) => {
    const currentRevision = ++revision.current;
    const saved = writes.current.catch(() => {}).then(() => write(next));
    writes.current = saved;
    await saved;
    if (revision.current !== currentRevision) return;
    setValue(next); apply?.(next);
  }, []);
  return [value, change] as const;
}
