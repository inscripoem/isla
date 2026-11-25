import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Glyph } from './ui'

/*
 * Console toast notifications, rendered through a portal on demand. This is
 * the console's own notification voice (the animal-island portal styling does
 * not match the kawaii design system). Same call shape the console used
 * before: `toast({ type, message, description?, duration? })`.
 *
 * The imperative entry point and the internal host components intentionally
 * share this module, so the fast-refresh export-shape rule is disabled here.
 */
/* oxlint-disable react/only-export-components */

export type ToastType = 'success' | 'info' | 'error'

export interface ToastOptions {
  readonly type: ToastType
  readonly message: string
  readonly description?: string
  /** Seconds; defaults to 4.5. */
  readonly duration?: number
}

interface ToastEntry extends ToastOptions {
  readonly id: number
  readonly leaving: boolean
}

let counter = 0
let renderRoot: { push(entry: ToastEntry): void } | null = null
const listeners = new Set<() => void>()
let items: readonly ToastEntry[] = []

function notify(): void {
  for (const listener of listeners) listener()
}

function ensureHost(): void {
  if (renderRoot !== null) return
  const host = document.createElement('div')
  host.setAttribute('data-isla-toast-root', '')
  document.body.appendChild(host)
  const root = createRoot(host)
  const Store = (): null => {
    const [, setTick] = useState(0)
    useEffect(() => {
      const listener = (): void => setTick((value) => value + 1)
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }, [])
    return null
  }
  root.render(
    <>
      <Store />
      <ToastViewport />
    </>,
  )
  renderRoot = {
    push(entry: ToastEntry): void {
      items = [...items, entry]
      notify()
      const life = (entry.duration ?? 4.5) * 1000
      window.setTimeout(() => dismiss(entry.id), life)
    },
  }
}

function dismiss(id: number): void {
  const entry = items.find((candidate) => candidate.id === id)
  if (entry === undefined || entry.leaving) return
  items = items.map((candidate) => (candidate.id === id ? { ...candidate, leaving: true } : candidate))
  notify()
  window.setTimeout(() => {
    items = items.filter((candidate) => candidate.id !== id)
    notify()
  }, 260)
}

const TYPE_ICON: Record<ToastType, 'heart' | 'spark' | 'boom'> = { success: 'heart', info: 'spark', error: 'boom' }

function ToastViewport() {
  return (
    <div className="isla-toasts" role="region" aria-label="Console notifications">
      {items.map((entry) => (
        <div key={entry.id} className={`isla-toast isla-toast--${entry.type} ${entry.leaving ? 'isla-toast--leaving' : ''}`.trim()}>
          <span className="isla-toast__icon" aria-hidden="true">
            <Glyph name={TYPE_ICON[entry.type]} size={17} />
          </span>
          <div>
            <p className="isla-toast__message">{entry.message}</p>
            {entry.description !== undefined && entry.description !== '' && (
              <p className="isla-toast__description">{entry.description}</p>
            )}
          </div>
          <button type="button" className="isla-toast__close" aria-label="Dismiss notification" onClick={() => dismiss(entry.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  )
}

export function toast(options: ToastOptions): void {
  ensureHost()
  counter += 1
  renderRoot?.push({ ...options, id: counter, leaving: false })
}
