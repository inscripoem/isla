/**
 * Private, SDK-independent tokenizer guard for the M1-02 Kokoro provider.
 *
 * The guard is an apply-only Proxy over the actual callable tokenizer returned by
 * `AutoTokenizer.from_pretrained`. The real `kokoro-js` generate path invokes its
 * tokenizer synchronously and destructures `input_ids` from the returned object
 * (`const { input_ids } = this.tokenizer(...)`), so the guard forwards the exact
 * supplied phoneme string to the original callable and clones the caller's
 * options, forcing `truncation:false`. Blank or whitespace-only phonemes are
 * refused before that call. After the synchronous encoding is validated, a
 * boundary-only pair `[0, 0]`/`[0n, 0n]` is refused as invalid phoneme material,
 * and an over-limit encoding is refused with the existing
 * `KokoroProviderError('input_too_long')` before the SDK can dispatch the model.
 * Invalid phoneme material is a plain `Error`, so the existing adapter maps it to
 * its ordinary provider-failure reason rather than `input_too_long`; an accepted
 * encoding is returned unchanged.
 *
 * The guard never slices, decodes or re-tokenizes a prefix, never uses a
 * character heuristic and never mutates the original tokenizer or the caller's
 * options object. An unverifiable runtime shape — including an empty
 * `[1, 0]` tensor or an asynchronous (Promise) result — fails honestly with a
 * plain `Error` rather than a truncation or a fabricated length.
 */
import { KokoroProviderError } from './kokoro-types'

/** Configured maximum sequence length (including special tokens). */
export const DEFAULT_MAX_TOKENS = 512

/**
 * The only tensor properties the guard reads: documented `data` and `dims`.
 * Real `input_ids` payloads are typed arrays such as `Int32Array` or
 * `BigInt64Array`, so the data view only promises array-like length.
 */
export interface KokoroTensorLike {
  readonly data: ArrayLike<number | bigint>
  readonly dims: readonly number[]
}

/** Encoding returned synchronously by the callable tokenizer. */
export interface KokoroTokenizerEncoding {
  readonly input_ids: KokoroTensorLike
  readonly [key: string]: unknown
}

/**
 * A synchronous callable tokenizer seam, matching the real SDK's boundary. The
 * real SDK instance is forwarded verbatim through the guard; this declaration
 * only describes the documented synchronous call and result.
 */
export type KokoroCallableTokenizer = (
  text: string,
  options?: Record<string, unknown>,
) => KokoroTokenizerEncoding

function malformed(detail: string): Error {
  return new Error(`m1-kokoro-guard: ${detail}`)
}

/**
 * The pinned tokenizer emits this two-token pair for phoneme input with no
 * content. Only the exact pair is rejected; longer legitimate sequences that
 * happen to contain zero ids are returned unchanged.
 */
function isBoundaryOnlyPair(data: ArrayLike<number | bigint>, sequence: number): boolean {
  if (sequence !== 2) return false
  const first = data[0]
  const second = data[1]
  return (first === 0 || first === 0n) && (second === 0 || second === 0n)
}

function isThenable(value: unknown): value is { then: unknown } {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}

/**
 * Inspect the full single-batch `input_ids` tensor synchronously and return its
 * complete sequence length. Rejects a missing tensor, non-integer dims, a length
 * that disagrees with the data size, an empty sequence, or a shape other than one
 * batch `[1, tokens]`.
 */
function sequenceLength(encoding: unknown): number {
  if (encoding === null || typeof encoding !== 'object') {
    throw malformed('tokenizer encoding is not an object')
  }
  const inputIds = (encoding as { input_ids?: unknown }).input_ids
  if (inputIds === null || typeof inputIds !== 'object') {
    throw malformed('input_ids is not a tensor')
  }
  const dims = (inputIds as { dims?: unknown }).dims
  const data = (inputIds as { data?: unknown }).data
  if (!Array.isArray(dims) || dims.length === 0) {
    throw malformed('input_ids.dims must be a nonempty array')
  }
  if (data === null || typeof data !== 'object' || typeof (data as { length?: unknown }).length !== 'number') {
    throw malformed('input_ids.data must be array-like')
  }
  let product = 1
  for (const dim of dims) {
    if (typeof dim !== 'number' || !Number.isInteger(dim) || dim < 0) {
      throw malformed('input_ids.dims must be nonnegative integers')
    }
    product *= dim
  }
  if (product !== (data as { length: number }).length) {
    throw malformed('input_ids data length does not match dims')
  }
  if (dims.length !== 2 || dims[0] !== 1) {
    throw malformed('input_ids must be a single batch of shape [1, tokens]')
  }
  const sequence = dims[1] as number
  if (sequence === 0) {
    throw malformed('input_ids must contain at least one token')
  }
  return sequence
}

/**
 * Wrap a callable tokenizer with an apply-only synchronous no-truncation guard.
 *
 * @param original the actual callable tokenizer (or any callable control in tests)
 * @param maxTokens configured maximum complete sequence length
 */
export function createGuardedTokenizer(
  original: KokoroCallableTokenizer,
  maxTokens: number = DEFAULT_MAX_TOKENS,
): KokoroCallableTokenizer {
  if (typeof original !== 'function') throw malformed('tokenizer must be callable')
  if (!Number.isInteger(maxTokens) || maxTokens <= 0) {
    throw malformed('maxTokens must be a positive integer')
  }
  return new Proxy(original, {
    apply(target, thisArg, argArray) {
      const text = argArray[0]
      const provided = argArray[1]
      if (typeof text !== 'string') throw malformed('tokenizer text must be a string')
      // Blank phoneme material has no content to tokenize; refusing it here keeps
      // the tokenizer and model out of the path entirely.
      if (text.trim().length === 0) {
        throw malformed('invalid phoneme material: text is blank or whitespace')
      }
      // Clone the caller's options and override only the truncation flag; the
      // SDK's own options object is never mutated.
      const options: Record<string, unknown> =
        provided === undefined || provided === null
          ? {}
          : { ...(provided as Record<string, unknown>) }
      options.truncation = false
      const result: unknown = Reflect.apply(
        target as (...args: unknown[]) => unknown,
        thisArg,
        [text, options],
      )
      // The real SDK destructures `input_ids` synchronously; a Promise here would
      // silently become `undefined` in `kokoro-js` rather than being awaited.
      if (isThenable(result)) {
        throw malformed('tokenizer must return its encoding synchronously, not a Promise')
      }
      const length = sequenceLength(result)
      const data = (result as KokoroTokenizerEncoding).input_ids.data
      // A nonblank request can still tokenize to the contentless boundary pair;
      // refuse it before the model sees it, without touching longer sequences.
      if (isBoundaryOnlyPair(data, length)) {
        throw malformed('invalid phoneme material: token ids are boundary-only [0, 0]')
      }
      if (length > maxTokens) throw new KokoroProviderError('input_too_long')
      return result as KokoroTokenizerEncoding
    },
  })
}
