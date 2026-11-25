import React, { createContext, useContext } from 'react';
import { ReservedRegionsProvider, useReservedRegions, type ReservedRegion } from 'react-native-reserved-regions';

const Regions = createContext<readonly ReservedRegion[]>([]);
function ReportRegions({ children }: { children: React.ReactNode }) {
  return <Regions.Provider value={useReservedRegions()}>{children}</Regions.Provider>;
}

// Root-window coordinates also apply to Paper portals. Native sheets own their window.
export function FoldProvider({ children }: { children: React.ReactNode }) {
  return <ReservedRegionsProvider style={{ flex: 1 }}><ReportRegions>{children}</ReportRegions></ReservedRegionsProvider>;
}
export const useFoldRegions = () => useContext(Regions);
