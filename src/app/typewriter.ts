// Paced reveal of streamed answer text ("typing speed"): instead of repainting on every model
// delta, the visible text grows by a fixed number of characters per tick, snapped to a word
// boundary so half-words never flash on the glasses.

// Characters per second. For reference, comfortable reading is roughly 20-25 cps.
export const TYPING_CPS: Record<string, number> = { off: 0, slowest: 6, slow: 11, normal: 18, fast: 30 }

/**
 * Advance `visible` toward `target` by about `chars` characters.
 * Returns `target` outright when `visible` is not a prefix of it (the final answer replaced the
 * streamed text with something different) or when the remainder is short.
 */
export function nextReveal(visible: string, target: string, chars: number): string {
  if (!target.startsWith(visible)) return target
  const remaining = target.length - visible.length
  if (remaining <= 0) return visible
  if (chars <= 0 || remaining <= chars + 12) return target
  let cut = visible.length + chars
  // Extend to the next whitespace (bounded) so words are revealed whole.
  const boundary = target.slice(cut, cut + 12).search(/\s/)
  if (boundary !== -1) cut += boundary
  return target.slice(0, cut)
}
