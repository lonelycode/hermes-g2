// Paced reveal of streamed answer text ("typing speed"): the visible text grows by whole words,
// each word charged against a character budget that accrues at the chosen speed, so the average
// rate is exact however slow the link is.

// Characters per second. For reference, comfortable reading is roughly 20-25 cps.
export const TYPING_CPS: Record<string, number> = { off: 0, slowest: 6, slow: 11, normal: 18, fast: 30 }

/** Longest common prefix length of two strings. */
function commonPrefix(a: string, b: string): number {
  const n = Math.min(a.length, b.length)
  let i = 0
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++
  return i
}

/**
 * Advance `visible` toward `target` spending at most `budget` characters, whole words at a time.
 * A word longer than `maxWord` may be revealed partially so a URL or code token cannot stall the
 * reveal. When `visible` is no longer a prefix of `target` (the final answer differs from the
 * streamed text) the reveal rewinds to the common prefix rather than dumping the rest.
 * Returns the new visible text and how much budget was spent.
 */
export function revealWords(visible: string, target: string, budget: number, maxWord = 14): { text: string; spent: number } {
  if (!target.startsWith(visible)) {
    const keep = commonPrefix(visible, target)
    return { text: target.slice(0, keep), spent: 0 }
  }
  let pos = visible.length
  let spent = 0
  while (pos < target.length) {
    // Next chunk: leading whitespace plus one word.
    let end = pos
    while (end < target.length && /\s/.test(target[end])) end++
    while (end < target.length && !/\s/.test(target[end])) end++
    const len = end - pos
    if (len <= budget - spent) {
      pos = end
      spent += len
      continue
    }
    // Not enough budget for the whole word: reveal part of a very long token, else stop.
    const room = Math.floor(budget - spent)
    if (len > maxWord && room >= 1) {
      pos += room
      spent += room
    }
    break
  }
  return { text: target.slice(0, pos), spent }
}
