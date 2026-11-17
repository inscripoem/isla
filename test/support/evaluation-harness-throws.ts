/**
 * Test-only harness whose factory throws.
 *
 * Its purpose is to prove ordering, not behaviour: when a spec or output is
 * refused, the command must not reach the harness at all, so this factory must
 * never run. A test that sees "factory threw" has found a broken pre-flight.
 */
export default function createUnreachableHarness(): never {
  throw new Error('the harness factory must not be called for a refused spec')
}
