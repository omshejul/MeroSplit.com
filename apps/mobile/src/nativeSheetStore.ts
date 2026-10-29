// Sheet bodies stay with their mounted form, never in serialized navigation params.
export function createNativeSheetStore<T>() {
  const entries = new Map<string, T>(), listeners = new Set<() => void>();
  const emit = () => listeners.forEach(listener => listener());
  return {
    get: (id: string) => entries.get(id),
    set(id: string, value: T) { entries.set(id, value); emit(); },
    remove(id: string) { if (entries.delete(id)) emit(); },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}
