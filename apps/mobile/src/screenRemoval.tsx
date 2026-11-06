import { createContext, useContext, useLayoutEffect } from 'react';

// Only an explicit false permits leaving without confirmation while restoration is unknown.
export type DraftDiscard = { current: (() => Promise<boolean>) | null; hasDraft?: boolean };
export const ScreenDraftDiscard = createContext<DraftDiscard>({ current: null });

export const ScreenRemovalLock = createContext<(blocked: boolean) => void>(() => {});
export function useScreenRemovalLock(blocked: boolean) {
  const setBlocked = useContext(ScreenRemovalLock);
  useLayoutEffect(() => { setBlocked(blocked); return () => setBlocked(false); }, [blocked, setBlocked]);
}
