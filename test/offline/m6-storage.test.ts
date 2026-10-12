import { describe, expect, it } from 'vitest'
import { collectStorageViolations } from '../conformance/storage.conformance'
import * as faulty from '../support/faulty-ports'
import { createEventStore, createMemoryProjection } from '../../src/storage'

describe('M6 storage conformance', () => {
  it('accepts the M6 event store and projection', async () => {
    const violations = await collectStorageViolations(() => {
      let failNextCommit = false
      const store = createEventStore({
        beforeCommit: () => {
          if (failNextCommit) {
            failNextCommit = false
            throw new Error('simulated storage failure')
          }
        },
      })
      return {
        store,
        projection: createMemoryProjection(),
        setFailNextCommit: () => {
          failNextCommit = true
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
