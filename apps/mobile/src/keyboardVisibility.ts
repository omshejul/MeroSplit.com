// A field can be taller than the usable viewport. Reveal its bottom/caret area
// instead of alternating between trying to fit its top and bottom.
export function keyboardScrollDelta(top: number, bottom: number, inputTop: number, height: number): number {
  const start = top + 12, end = bottom - 12;
  if (end <= start || height <= 0) return 0;
  if (inputTop + height > end) return inputTop + height - end;
  if (inputTop < start && height <= end - start) return inputTop - start;
  return 0;
}
