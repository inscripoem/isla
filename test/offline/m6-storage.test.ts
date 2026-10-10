import { describe, expect, it } from 'vitest'
import { collectStorageViolations } from '../conformance/storage.conformance'
import * as correct from '../support/correct-ports'
import * as faulty from '../support/faulty-ports'

describe('M6 storage conformance', () => {
  it('accepts the correct event store and projection', async () => {
    const violations = await collectStorageViolations(() => {
      const store = correct.createFixtureEventStore()
      return {
        store,
        projection: correct.createFixtureMemoryProjection(),
        setFailNextCommit: () => {
          store.failNextCommit = true
        },
      }
    })
    expect(violations).toEqual([])
  })

  it('rejects a faulty store and projection', async () => {
    const violations = await collectStorageViolations(() => {
      const store = faulty.createFaultyEventStore()
      return {
        store: store.store,
        projection: faulty.createFaultyMemoryProjection(),
        setFailNextCommit: () => {
          store.failNextCommit = true
        },
      }
    })
    const codes = violations.map((violation) => violation.code)
    expect(codes).toContain('append-duplicate')
    expect(codes).toContain('append-seq-unique')
    expect(codes).toContain('delivery-changed-content-conflict')
    expect(codes).toContain('atomic-failure-reported')
    expect(codes).toContain('projection-no-gap-claim')
  })
})
