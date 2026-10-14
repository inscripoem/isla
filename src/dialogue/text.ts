/**
 * Substantive-speech test and final-text normalization.
 *
 * M4 decides whether speech content exists at all. A final segment containing no
 * letter or digit is not speech. Callers must filter such text BEFORE calling
 * DialogueSink: emitting it and discarding it afterwards would still make it
 * generated text, which is exactly what the invariant forbids.
 *
 * The pattern below stays consistent with the `dialogue-substantive` conformance
 * assertion; if either side changes, the other must change with it.
 */

const SUBSTANTIVE_PATTERN = /\p{L}|\p{N}/u

/** True when the text contains at least one letter or digit. */
export function isSubstantiveSpeech(text: string): boolean {
  return SUBSTANTIVE_PATTERN.test(text)
}

/**
 * Normalize a candidate before it is finalized. Only leading and trailing
 * whitespace is removed; the words actually spoken are never rewritten.
 */
export function normalizeFinalText(text: string): string {
  return text.trim()
}
