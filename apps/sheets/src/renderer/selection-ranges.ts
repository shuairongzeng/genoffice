/** Serialize the sheet's selected ranges for the AI panel's selection chip:
 *  the A1 notation of EVERY selected range (multi-select included), joined
 *  with ", " — no cell-value dump; the model knows which cells to read/edit. */
export function formatSelectionRanges(
  ranges: readonly { getA1Notation?: (() => string) | undefined }[],
): string {
  return ranges
    .map((range) => range.getA1Notation?.() ?? '')
    .filter(Boolean)
    .join(', ')
}
