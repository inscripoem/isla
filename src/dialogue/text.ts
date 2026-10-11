/**
 * Substantive-speech predicate and finalized-text normalization.
 *
 * M4 owns the no-speech decision. A finalized segment carrying no letter and no
 * digit is not speech. Callers must filter such text BEFORE invoking
 * DialogueSink: emitting it and discarding the result afterwards would still
 * make it generated text, which is exactly what the invariant forbids.
 *
 * The pattern below mirrors the `dialogue-substantive` conformance assertion.
 * If either side changes, change both.
 */

const SUBSTANTIVE_PATTERN = /\p{L}|\p{N}/u

/** True when the text contains at least one letter or digit. */
export function isSubstantiveSpeech(text: string): boolean {
  return SUBSTANTIVE_PATTERN.test(text)
}

/**
 * Normalizes candidate text before it is finalized. Only outward whitespace is
 * removed; the spoken content itself is never rewritten here.
 */
export function normalizeFinalText(text: string): string {
  return text.trim()
}
