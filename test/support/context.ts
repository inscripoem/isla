import type { CallContext } from '../../src/contracts'

export interface CallContextHandle extends CallContext {
  abort(): void
  readonly controller: AbortController
}

export function createCallContext(deadlineAtMs = 60_000): CallContextHandle {
  const controller = new AbortController()
  return {
    signal: controller.signal,
    deadline: { atMs: deadlineAtMs },
    controller,
    abort: () => controller.abort(),
  }
}

export interface Gate {
  readonly promise: Promise<void>
  release(): void
  readonly opened: boolean
}

/** A manually released gate for holding async fixture work. */
export function createGate(): Gate {
  let releaseFn: () => void = () => {}
  let opened = false
  const promise = new Promise<void>((resolve) => {
    releaseFn = () => {
      opened = true
      resolve()
    }
  })
  return {
    promise,
    release: () => releaseFn(),
    get opened() {
      return opened
    },
  }
}
