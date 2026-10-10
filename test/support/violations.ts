export interface Violation {
  code: string
  detail: string
}

export interface Checker {
  check(code: string, condition: boolean, detail: string): void
  violations(): Violation[]
}

/**
 * Collects observable contract violations instead of throwing, so the same
 * assertions can be run against correct and deliberately faulty adapters.
 */
export function createChecker(): Checker {
  const items: Violation[] = []
  return {
    check(code, condition, detail) {
      if (!condition) items.push({ code, detail })
    },
    violations() {
      return [...items]
    },
  }
}
