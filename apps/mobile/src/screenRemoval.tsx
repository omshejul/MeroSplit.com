import { createContext, useContext, useLayoutEffect } from 'react';

export const ScreenDraftDiscard = createContext<{ current: (() => Promise<boolean>) | null }>({ current: null });

export const ScreenRemovalLock = createContext<(blocked: boolean) => void>(() => {});
export function useScreenRemovalLock(blocked: boolean) {
  const setBlocked = useContext(ScreenRemovalLock);
  useLayoutEffect(() => { setBlocked(blocked); return () => setBlocked(false); }, [blocked, setBlocked]);
}
