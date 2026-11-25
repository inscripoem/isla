import { useEffect, useRef, useState } from 'react'

/**
 * Streaming typewriter: reveals text character by character, like a live
 * caption feed. Restarts whenever the text changes; long texts accelerate so
 * a full subtitle never lags behind the audio. Honours reduced motion by
 * showing the full text immediately.
 */

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)'
const BASE_MS_PER_CHAR = 34
const MIN_MS_PER_CHAR = 8

export interface TypewriterResult {
  /** The currently revealed slice of the text. */
  readonly shown: string
  /** True while more characters are still pending. */
  readonly typing: boolean
}

/** Characters revealed for `text` before the interval starts ticking. */
function initialCount(text: string | null): number {
  if (text === null || text.length === 0) return 0
  if (window.matchMedia(REDUCED_MOTION).matches) return Number.MAX_SAFE_INTEGER
  return 0
}

export function useTypewriter(text: string | null): TypewriterResult {
  // Adjust during render instead of in an effect: a text change resets the
  // reveal synchronously, then the interval below advances it.
  const [previous, setPrevious] = useState(text)
  const [count, setCount] = useState(() => initialCount(text))
  const timer = useRef<number | null>(null)

  if (previous !== text) {
    setPrevious(text)
    setCount(initialCount(text))
  }

  useEffect(() => {
    if (timer.current !== null) {
      window.clearInterval(timer.current)
      timer.current = null
    }
    if (text === null || text.length === 0) return
    if (window.matchMedia(REDUCED_MOTION).matches) return
    // Faster per character for long lines so the reveal keeps up with speech.
    const perChar = Math.max(MIN_MS_PER_CHAR, BASE_MS_PER_CHAR - text.length * 0.28)
    timer.current = window.setInterval(() => {
      setCount((current) => {
        if (current >= text.length) {
          if (timer.current !== null) {
            window.clearInterval(timer.current)
            timer.current = null
          }
          return current
        }
        return current + 1
      })
    }, perChar)
    return () => {
      if (timer.current !== null) {
        window.clearInterval(timer.current)
        timer.current = null
      }
    }
  }, [text])

  if (text === null || text.length === 0) return { shown: '', typing: false }
  const shown = text.slice(0, count)
  return { shown, typing: shown.length < text.length }
}
