import { createContext, useContext } from 'react';
export const RowDividerContext = createContext<boolean | undefined>(undefined);
export function useRowDivider(divider?: boolean): boolean {
  const grouped = useContext(RowDividerContext);
  return divider ?? grouped ?? true;
}
