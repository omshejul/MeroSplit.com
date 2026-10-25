// Center the entire intrinsic group near 40% of the available viewport.
// A short viewport or enlarged content falls back to normal scroll padding.
export function signInTopPadding(viewportHeight: number, contentHeight: number): number {
  return Math.max(24, (viewportHeight * 0.8 - contentHeight) / 2);
}
