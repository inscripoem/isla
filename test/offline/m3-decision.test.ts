import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type {
  ClockPort,
  SelectionPort,
  SelectionRequest,
} from '../../src/contracts'
import { selectionResultSchema } from '../../src/contracts'
import {
  SelectionCallError,
  createRuleSelectionPort,
} from '../../src/decision'
import { collectDecisionViolations } from '../conformance/decision.conformance'
import * as correct from '../support/correct-ports'
import * as faulty from '../support/faulty-ports'
import { createCallContext } from '../support/context'
import {
  DecisionCorpusError,
  decisionReferenceLabelSchema,
  decisionReviewRecordSchema,
  findDecisionCase,
  loadDecisionCorpus,
  toEvalCase,
} from '../support/decision-corpus'
import type {
  DecisionReferenceLabel,
  LoadedDecisionCorpus,
  LoadedDecisionCorpusCase,
} from '../support/decision-corpus'
import {
  runSelectionCorpus,
  runSelectionCorpusFromManifest,
} from '../support/decision-runner'
import { createSyntheticReviewedCorpus } from '../support/decision-synthetic-review'
import {
  fixtureInputEvent,
  fixtureSelectionRequest,
  fixtureSelectionResult,
} from '../support/fixture-data'
import { createVirtualClock } from '../support/virtual-clock'

const CORPUS_DIR = join(process.cwd(), 'test', 'fixtures', 'decision', 'v1')
const CORPUS_MANIFEST = join(CORPUS_DIR, 'manifest.json')

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

function ruleRequest(overrides: Partial<SelectionRequest> = {}): SelectionRequest {
  return fixtureSelectionRequest({
    deadline: { atMs: 3000 },
    ...overrides,
  })
}

function ruleSelection() {
  return {
    createSelection: (clock: ClockPort) => createRuleSelectionPort({ clock }),
  }
}

function reviewedRecord(reviewedAt: string) {
  return {
    caseId: 'selection-001',
    status: 'reviewed' as const,
    provenance: 'human' as const,
    reviewerId: 'reviewer',
    reviewedAt,
    requestSha256: 'a'.repeat(64),
    labelSha256: 'b'.repeat(64),
  }
}

function manualCase(options: {
  readonly id: string
  readonly initialNowMs: number
  readonly deadlineAtMs: number
  readonly receivedAtMs: number
  readonly expiresAtMs: number
}): LoadedDecisionCorpusCase {
  const sessionId = `session-${options.id}`
  const eventId = `event-${options.id}`
  const request = fixtureSelectionRequest({
    requestId: `request-${options.id}`,
    sessionId,
    epoch: 0,
    snapshotRevision: 1,
    candidates: [
      fixtureInputEvent({
        eventId,
        sessionId,
        epoch: 0,
        receivedAtMs: options.receivedAtMs,
        expiresAtMs: options.expiresAtMs,
      }),
    ],
    deadline: { atMs: options.deadlineAtMs },
  })
  const label: DecisionReferenceLabel = {
    caseId: options.id,
    selectionScores: [
      { disposition: 'respond', selectedEventIds: [eventId], score: 2 },
      { disposition: 'defer', selectedEventIds: [], score: 0 },
    ],
    intentLabels: [
      {
        selectedEventId: eventId,
        acceptableIntents: ['answer'],
        coverage: 'partial',
        coverageRationale: null,
      },
    ],
    rationale: 'Manual per-case clock test case; not corpus evidence.',
  }
  return {
    entry: {
      id: options.id,
      requestFile: `requests/${options.id}.json`,
      labelFile: `labels/${options.id}.json`,
      reviewFile: `reviews/${options.id}.json`,
      initialNowMs: options.initialNowMs,
      heldOut: false,
      executionMode: 'selection-port',
    },
    request,
    label,
    review: {
      caseId: options.id,
      status: 'draft',
      notes: 'Manual per-case clock test case; not corpus evidence.',
    },
    corpusVersion: 'manual-clock-test',
    rubricVersion: 'manual-clock-test',
  }
}

function manualCorpus(cases: readonly LoadedDecisionCorpusCase[]): LoadedDecisionCorpus {
  return {
    root: 'manual-clock-test',
    manifest: {
      schemaVersion: 1,
      hashVersion: 1,
      corpusVersion: 'manual-clock-test',
      rubricVersion: 'manual-clock-test',
      casesSha256: '0'.repeat(64),
      cases: cases.map((entry) => entry.entry),
    },
    cases,
    casesSha256: '0'.repeat(64),
  }
}

function corpusError(run: () => unknown): DecisionCorpusError {
  try {
    run()
  } catch (error) {
    if (error instanceof DecisionCorpusError) return error
    throw error
  }
  throw new Error('expected a DecisionCorpusError')
}

function baseCorpus(): LoadedDecisionCorpus {
  return loadDecisionCorpus(CORPUS_MANIFEST)
}

function withCopiedCorpus(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'm3-corpus-'))
  try {
    cpSync(CORPUS_DIR, root, { recursive: true })
    run(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function findObservation(
  result: Awaited<ReturnType<typeof runSelectionCorpus>>,
  caseId: string,
) {
  if (result.status !== 'ran') throw new Error(`expected a ran corpus, got ${result.status}`)
  const observation = result.observations.find((entry) => entry.caseId === caseId)
  if (observation === undefined) throw new Error(`missing observation for ${caseId}`)
  return observation
}

describe('M3 decision conformance', () => {
  it('accepts the correct selection and reaction adapters', async () => {
    const violations = await collectDecisionViolations(() => ({
      selection: correct.createFixtureSelectionPort(),
      reaction: correct.createFixtureReactionPort(),
    }))
    expect(violations).toEqual([])
  })

  it('rejects an unoffered selection and an ineligible reaction', async () => {
    const violations = await collectDecisionViolations(() => ({
      selection: faulty.createFaultySelectionPort(),
      reaction: faulty.createFaultyReactionPort(),
    }))
    const codes = violations.map((violation) => violation.code)
    expect(codes).toContain('selection-offered')
    expect(codes).toContain('reaction-eligible')
  })
})

describe('M3 rule SelectionPort (actual implementation)', () => {
  it('selects the oldest offered candidate', async () => {
    const clock = createVirtualClock(1000)
    const port = createRuleSelectionPort({ clock })
    const request = ruleRequest({
      candidates: [
        fixtureInputEvent({ eventId: 'late', receivedAtMs: 900 }),
        fixtureInputEvent({ eventId: 'early', receivedAtMs: 800 }),
      ],
    })
    const result = await port.select(request, createCallContext(3000))
    expect(result.selectedEventIds).toEqual(['early'])
    expect(result.replyIntent).toBe('answer')
  })

  it('breaks equal receive-time ties by offered order', async () => {
    const clock = createVirtualClock(1000)
    const port = createRuleSelectionPort({ clock })
    const request = ruleRequest({
      candidates: [
        fixtureInputEvent({ eventId: 'first', receivedAtMs: 800 }),
        fixtureInputEvent({ eventId: 'second', receivedAtMs: 800 }),
      ],
    })
    const result = await port.select(request, createCallContext(3000))
    expect(result.selectedEventIds).toEqual(['first'])
  })

  it('prefers answer when it is allowed', async () => {
    const clock = createVirtualClock(1000)
    const port = createRuleSelectionPort({ clock })
    const request = ruleRequest({ allowedIntents: ['clarify', 'answer'] })
    const result = await port.select(request, createCallContext(3000))
    expect(result.replyIntent).toBe('answer')
  })

  it('falls back to the first allowed intent when answer is unavailable', async () => {
    const clock = createVirtualClock(1000)
    const port = createRuleSelectionPort({ clock })
    const request = ruleRequest({ allowedIntents: ['clarify', 'support'] })
    const result = await port.select(request, createCallContext(3000))
    expect(result.replyIntent).toBe('clarify')
  })

  it('echoes request identity and revision', async () => {
    const clock = createVirtualClock(1000)
    const port = createRuleSelectionPort({ clock })
    const request = ruleRequest()
    const result = await port.select(request, createCallContext(3000))
    expect(result).toMatchObject({
      requestId: request.requestId,
      sessionId: request.sessionId,
      epoch: request.epoch,
      snapshotRevision: request.snapshotRevision,
    })
    expect(selectionResultSchema.safeParse(result).success).toBe(true)
  })

  it('does not mutate the request or its candidates', async () => {
    const clock = createVirtualClock(1000)
    const port = createRuleSelectionPort({ clock })
    const request = deepFreeze(ruleRequest({
      candidates: [
        fixtureInputEvent({ eventId: 'late', receivedAtMs: 900 }),
        fixtureInputEvent({ eventId: 'early', receivedAtMs: 800 }),
      ],
    }))
    const snapshot = structuredClone(request)
    await port.select(request, createCallContext(3000))
    expect(request).toEqual(snapshot)
  })

  it('rejects a pre-expired selection call before candidate evaluation', async () => {
    const clock = createVirtualClock(3001)
    const port = createRuleSelectionPort({ clock })
    await expect(
      port.select(ruleRequest(), createCallContext(3000)),
    ).rejects.toMatchObject({ code: 'deadline-exceeded' })
  })

  it('rejects a selection call exactly at the governing deadline', async () => {
    const clock = createVirtualClock(3000)
    const port = createRuleSelectionPort({ clock })
    await expect(
      port.select(ruleRequest(), createCallContext(3000)),
    ).rejects.toMatchObject({ code: 'deadline-exceeded' })
  })

  it('uses the earlier of the request and CallContext deadlines', async () => {
    const port = createRuleSelectionPort({ clock: createVirtualClock(2500) })
    await expect(
      port.select(ruleRequest({ deadline: { atMs: 3000 } }), createCallContext(2000)),
    ).rejects.toMatchObject({ code: 'deadline-exceeded' })
    await expect(
      port.select(ruleRequest({ deadline: { atMs: 2000 } }), createCallContext(3000)),
    ).rejects.toMatchObject({ code: 'deadline-exceeded' })
  })

  it('rejects a non-finite governing deadline', async () => {
    const port = createRuleSelectionPort({ clock: createVirtualClock(0) })
    await expect(
      port.select(
        ruleRequest({ deadline: { atMs: Number.POSITIVE_INFINITY } }),
        createCallContext(3000),
      ),
    ).rejects.toMatchObject({ code: 'invalid-deadline' })
  })

  it('rejects a pre-aborted selection call without returning a proposal', async () => {
    const port = createRuleSelectionPort({ clock: createVirtualClock(1000) })
    const context = createCallContext(3000)
    context.abort()
    await expect(port.select(ruleRequest(), context)).rejects.toMatchObject({
      code: 'aborted',
    })
  })
})

describe('M3 review-date validation', () => {
  it('accepts real UTC calendar dates for reviewedAt', () => {
    for (const reviewedAt of ['2024-02-29', '2026-02-28', '2026-12-31']) {
      expect(decisionReviewRecordSchema.safeParse(reviewedRecord(reviewedAt)).success).toBe(
        true,
      )
    }
  })

  it('rejects impossible UTC calendar dates for reviewedAt', () => {
    for (const reviewedAt of [
      '2026-02-31',
      '2025-02-29',
      '2026-04-31',
      '2026-13-01',
      '2026-00-10',
      '2026-2-03',
    ]) {
      expect(decisionReviewRecordSchema.safeParse(reviewedRecord(reviewedAt)).success).toBe(
        false,
      )
    }
  })
})

describe('M3 selection corpus v1', () => {
  it('loads m3-selection-v1 and rejects a duplicate case id', () => {
    const base = baseCorpus()
    expect(base.manifest.corpusVersion).toBe('m3-selection-v1')
    expect(base.cases).toHaveLength(2)
    expect(findDecisionCase(base, 'selection-001').review.status).toBe('reviewed')
    expect(findDecisionCase(base, 'selection-002').review.status).toBe('draft')

    const root = mkdtempSync(join(tmpdir(), 'm3-duplicate-case-'))
    try {
      const manifest = {
        ...base.manifest,
        cases: [base.manifest.cases[0]!, base.manifest.cases[0]!],
      }
      writeJson(join(root, 'manifest.json'), manifest)
      expect(corpusError(() => loadDecisionCorpus(join(root, 'manifest.json'))).code).toBe(
        'duplicate-case-id',
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects duplicate offered candidate event ids', () => {
    withCopiedCorpus((root) => {
      const requestPath = join(root, 'requests', 'selection-001.json')
      const request = JSON.parse(readFileSync(requestPath, 'utf8'))
      request.candidates[1].eventId = request.candidates[0].eventId
      writeJson(requestPath, request)
      expect(corpusError(() => loadDecisionCorpus(join(root, 'manifest.json'))).code).toBe(
        'duplicate-candidate-id',
      )
    })
  })

  it('rejects a manifest path that escapes the corpus directory', () => {
    const base = baseCorpus()
    const root = mkdtempSync(join(tmpdir(), 'm3-escape-'))
    try {
      const manifest = {
        ...base.manifest,
        cases: [{ ...base.manifest.cases[0]!, requestFile: '../escape.json' }],
      }
      writeJson(join(root, 'manifest.json'), manifest)
      expect(corpusError(() => loadDecisionCorpus(join(root, 'manifest.json'))).code).toBe(
        'manifest-invalid',
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects a corpus content hash mismatch', () => {
    withCopiedCorpus((root) => {
      const manifestPath = join(root, 'manifest.json')
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      manifest.casesSha256 = '0'.repeat(64)
      writeJson(manifestPath, manifest)
      expect(corpusError(() => loadDecisionCorpus(manifestPath)).code).toBe(
        'corpus-hash-mismatch',
      )
    })
  })

  it('rejects a respond label with zero selected event ids', () => {
    const label = structuredClone(baseCorpus().cases[0]!.label)
    label.selectionScores = [
      { disposition: 'respond', selectedEventIds: [], score: 2 },
    ]
    expect(decisionReferenceLabelSchema.safeParse(label).success).toBe(false)
  })

  it('rejects a respond label with two selected event ids', () => {
    const label = structuredClone(baseCorpus().cases[0]!.label)
    label.selectionScores = [
      {
        disposition: 'respond',
        selectedEventIds: ['message-001', 'message-002'],
        score: 2,
      },
    ]
    expect(decisionReferenceLabelSchema.safeParse(label).success).toBe(false)
  })

  it('rejects a respond label that names an unoffered candidate', () => {
    withCopiedCorpus((root) => {
      const labelPath = join(root, 'labels', 'selection-001.json')
      const label = JSON.parse(readFileSync(labelPath, 'utf8'))
      label.selectionScores[0].selectedEventIds = ['message-999']
      writeJson(labelPath, label)
      expect(corpusError(() => loadDecisionCorpus(join(root, 'manifest.json'))).code).toBe(
        'label-invalid',
      )
    })
  })

  it('rejects a reviewed label with incomplete candidate coverage', () => {
    const base = baseCorpus()
    const label = structuredClone(base.cases[0]!.label)
    label.selectionScores = [
      { disposition: 'respond', selectedEventIds: ['message-001'], score: 2 },
      { disposition: 'defer', selectedEventIds: [], score: 0 },
    ]
    const synthetic = createSyntheticReviewedCorpus({
      base,
      labelOverrides: { 'selection-001': label },
    })
    try {
      expect(
        corpusError(() =>
          loadDecisionCorpus(synthetic.manifestPath, { allowSynthetic: true }),
        ).code,
      ).toBe('label-coverage-incomplete')
    } finally {
      synthetic.cleanup()
    }
  })

  it('rejects a reviewed label whose request or label content changed after review', () => {
    const requestSynthetic = createSyntheticReviewedCorpus({ base: baseCorpus() })
    try {
      const requestPath = join(requestSynthetic.root, 'requests', 'selection-001.json')
      const request = JSON.parse(readFileSync(requestPath, 'utf8'))
      request.requestId = 'selection-request-001-changed'
      writeJson(requestPath, request)
      expect(
        corpusError(() =>
          loadDecisionCorpus(requestSynthetic.manifestPath, { allowSynthetic: true }),
        ).code,
      ).toBe('review-content-mismatch')
    } finally {
      requestSynthetic.cleanup()
    }

    const labelSynthetic = createSyntheticReviewedCorpus({ base: baseCorpus() })
    try {
      const labelPath = join(labelSynthetic.root, 'labels', 'selection-001.json')
      const label = JSON.parse(readFileSync(labelPath, 'utf8'))
      label.rationale = 'Changed after review.'
      writeJson(labelPath, label)
      expect(
        corpusError(() =>
          loadDecisionCorpus(labelSynthetic.manifestPath, { allowSynthetic: true }),
        ).code,
      ).toBe('review-content-mismatch')
    } finally {
      labelSynthetic.cleanup()
    }
  })

  it('rejects a synthetic review record in the real corpus mode', () => {
    const synthetic = createSyntheticReviewedCorpus({ base: baseCorpus() })
    try {
      expect(corpusError(() => loadDecisionCorpus(synthetic.manifestPath)).code).toBe(
        'review-provenance-rejected',
      )
    } finally {
      synthetic.cleanup()
    }
  })

  it('rejects an exhaustive intent label without a reviewed coverage rationale', () => {
    const label = structuredClone(baseCorpus().cases[0]!.label)
    label.intentLabels[0]!.coverage = 'exhaustive'
    label.intentLabels[0]!.coverageRationale = null
    expect(decisionReferenceLabelSchema.safeParse(label).success).toBe(false)

    withCopiedCorpus((root) => {
      const labelPath = join(root, 'labels', 'selection-002.json')
      const draftLabel = JSON.parse(readFileSync(labelPath, 'utf8'))
      draftLabel.intentLabels[0].coverage = 'exhaustive'
      draftLabel.intentLabels[0].coverageRationale = 'The reviewer considered every allowed intent.'
      writeJson(labelPath, draftLabel)
      expect(corpusError(() => loadDecisionCorpus(join(root, 'manifest.json'))).code).toBe(
        'exhaustive-coverage-unjustified',
      )
    })
  })

  it('treats an unlisted allowed intent as unassessed under partial coverage', async () => {
    const base = baseCorpus()
    const label = structuredClone(base.cases[0]!.label)
    label.intentLabels[0]!.acceptableIntents = ['clarify']
    label.intentLabels[0]!.coverage = 'partial'
    label.intentLabels[0]!.coverageRationale = null
    const synthetic = createSyntheticReviewedCorpus({
      base,
      labelOverrides: { 'selection-001': label },
    })
    try {
      const corpus = loadDecisionCorpus(synthetic.manifestPath, { allowSynthetic: true })
      const result = await runSelectionCorpus(corpus, {
        ...ruleSelection(),
        allowSynthetic: true,
      })
      const observation = findObservation(result, 'selection-001')
      expect(observation.status).toBe('observed')
      if (observation.status !== 'observed') return
      expect(observation.candidateScore).toBe(2)
      expect(observation.adoptedScore).toBe(2)
      expect(observation.intentSuitability).toBe('unassessed')
    } finally {
      synthetic.cleanup()
    }
  })

  it('treats an unlisted allowed intent as inappropriate only with reviewed exhaustive coverage', async () => {
    const base = baseCorpus()
    const label = structuredClone(base.cases[0]!.label)
    label.intentLabels[0]!.acceptableIntents = ['clarify']
    label.intentLabels[0]!.coverage = 'exhaustive'
    label.intentLabels[0]!.coverageRationale =
      'The reviewer considered every allowed intent; only clarify is suitable for this candidate.'
    const synthetic = createSyntheticReviewedCorpus({
      base,
      labelOverrides: { 'selection-001': label },
    })
    try {
      const corpus = loadDecisionCorpus(synthetic.manifestPath, { allowSynthetic: true })
      const result = await runSelectionCorpus(corpus, {
        ...ruleSelection(),
        allowSynthetic: true,
      })
      const observation = findObservation(result, 'selection-001')
      expect(observation.status).toBe('observed')
      if (observation.status !== 'observed') return
      expect(observation.candidateScore).toBe(2)
      expect(observation.adoptedScore).toBe(2)
      expect(observation.intentSuitability).toBe('inappropriate')
    } finally {
      synthetic.cleanup()
    }
  })

  it('maps a corpus case to EvalCase without a reply intent or labels', () => {
    const base = baseCorpus()
    const entry = findDecisionCase(base, 'selection-001')
    const evalCase = toEvalCase(entry.entry, entry.request)
    expect(evalCase).toEqual({
      id: 'selection-001',
      input: 'Which game are you playing?',
      heldOut: false,
    })
    expect('replyIntent' in evalCase).toBe(false)
    expect('labels' in evalCase).toBe(false)
  })

  it('rejects a missing or ambiguous corpus case id', () => {
    const base = baseCorpus()
    expect(corpusError(() => findDecisionCase(base, 'missing-case')).code).toBe('case-missing')
  })

  it('rejects an unsupported execution mode', () => {
    const base = baseCorpus()
    const root = mkdtempSync(join(tmpdir(), 'm3-mode-'))
    try {
      const manifest = {
        ...base.manifest,
        cases: [{ ...base.manifest.cases[0]!, executionMode: 'full-pipeline' }],
      }
      writeJson(join(root, 'manifest.json'), manifest)
      const error = corpusError(() => loadDecisionCorpus(join(root, 'manifest.json')))
      expect(error.code).toBe('manifest-invalid')
      expect(error.message).toContain('executionMode')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('M3 direct selection runner', () => {
  it('runs the actual rule SelectionPort on a fixture request', async () => {
    const base = baseCorpus()
    const result = await runSelectionCorpus(base, ruleSelection())
    const observation = findObservation(result, 'selection-001')
    expect(observation.status).toBe('observed')
    if (observation.status !== 'observed') return
    expect(observation.disposition).toBe('respond')
    expect(observation.selectedEventId).toBe('message-001')
    expect(observation.replyIntent).toBe('answer')
    expect(observation.labelStatus).toBe('reviewed')
    expect(observation.scoreStatus).toBe('adopted')
    expect(observation.adoptedScore).toBe(2)
    expect(observation.candidateScore).toBe(2)
    expect(observation.intentSuitability).toBe('appropriate')
    expect(observation.certifiesCorpus).toBe(true)
  })

  it('uses each case initialNowMs for the port clock and validation', async () => {
    const cases = [
      manualCase({
        id: 'case-early',
        initialNowMs: 1000,
        deadlineAtMs: 3000,
        receivedAtMs: 800,
        expiresAtMs: 6000,
      }),
      manualCase({
        id: 'case-late-valid',
        initialNowMs: 5000,
        deadlineAtMs: 6000,
        receivedAtMs: 4000,
        expiresAtMs: 5500,
      }),
      manualCase({
        id: 'case-late-expired',
        initialNowMs: 5000,
        deadlineAtMs: 6000,
        receivedAtMs: 4000,
        expiresAtMs: 4500,
      }),
      manualCase({
        id: 'case-late-deadline',
        initialNowMs: 5000,
        deadlineAtMs: 4000,
        receivedAtMs: 3000,
        expiresAtMs: 6000,
      }),
    ]
    const seen: Array<{ id: string; nowMs: number }> = []
    const contextKeys: string[][] = []
    const result = await runSelectionCorpus(manualCorpus(cases), {
      createSelection: (clock, context) => {
        seen.push({ id: context.caseId, nowMs: clock.nowMs() })
        contextKeys.push(Object.keys(context).sort())
        return createRuleSelectionPort({ clock })
      },
    })
    expect(seen).toEqual([
      { id: 'case-early', nowMs: 1000 },
      { id: 'case-late-valid', nowMs: 5000 },
      { id: 'case-late-expired', nowMs: 5000 },
      { id: 'case-late-deadline', nowMs: 5000 },
    ])
    expect(contextKeys).toEqual([
      ['caseId', 'initialNowMs'],
      ['caseId', 'initialNowMs'],
      ['caseId', 'initialNowMs'],
      ['caseId', 'initialNowMs'],
    ])

    const early = findObservation(result, 'case-early')
    expect(early.status).toBe('observed')
    const lateValid = findObservation(result, 'case-late-valid')
    expect(lateValid.status).toBe('observed')

    const lateExpired = findObservation(result, 'case-late-expired')
    expect(lateExpired.status).toBe('invalid-result')
    if (lateExpired.status === 'invalid-result') {
      expect(lateExpired.reason).toBe('candidate-expired')
    }

    const lateDeadline = findObservation(result, 'case-late-deadline')
    expect(lateDeadline.status).toBe('technical-failure')
    if (lateDeadline.status === 'technical-failure') {
      expect(lateDeadline.failure.kind).toBe('deadline-exceeded')
    }
  })

  it('records a selection-factory failure per case and continues the corpus', async () => {
    const cases = [
      manualCase({
        id: 'case-factory-fails',
        initialNowMs: 1000,
        deadlineAtMs: 3000,
        receivedAtMs: 800,
        expiresAtMs: 6000,
      }),
      manualCase({
        id: 'case-after-factory-1',
        initialNowMs: 2000,
        deadlineAtMs: 4000,
        receivedAtMs: 1800,
        expiresAtMs: 6000,
      }),
      manualCase({
        id: 'case-after-factory-2',
        initialNowMs: 3000,
        deadlineAtMs: 5000,
        receivedAtMs: 2800,
        expiresAtMs: 6000,
      }),
    ]
    const constructed: string[] = []
    const result = await runSelectionCorpus(manualCorpus(cases), {
      createSelection: (clock, context) => {
        constructed.push(context.caseId)
        if (context.caseId === 'case-factory-fails') {
          throw new Error('factory boom')
        }
        return createRuleSelectionPort({ clock })
      },
    })
    expect(constructed).toEqual([
      'case-factory-fails',
      'case-after-factory-1',
      'case-after-factory-2',
    ])

    const failed = findObservation(result, 'case-factory-fails')
    expect(failed.status).toBe('technical-failure')
    if (failed.status === 'technical-failure') {
      expect(failed.failure.kind).toBe('construction-failed')
      expect(failed.adoptedScore).toBeNull()
    }
    expect(findObservation(result, 'case-after-factory-1').status).toBe('observed')
    expect(findObservation(result, 'case-after-factory-2').status).toBe('observed')
  })

  it('does not pass reference labels to the SelectionPort', async () => {
    const base = baseCorpus()
    const seen: SelectionRequest[] = []
    const spy: SelectionPort = {
      async select(request) {
        seen.push(request)
        const candidate = request.candidates[0]!
        return fixtureSelectionResult({
          requestId: request.requestId,
          sessionId: request.sessionId,
          epoch: request.epoch,
          snapshotRevision: request.snapshotRevision,
          selectedEventIds: [candidate.eventId],
          replyIntent: 'answer',
        })
      },
    }
    await runSelectionCorpus(base, { createSelection: () => spy })
    expect(seen).toHaveLength(2)
    expect(seen[0]).toEqual(base.cases[0]!.request)
    expect('selectionScores' in seen[0]!).toBe(false)
    expect('labels' in seen[0]!).toBe(false)
  })

  it('records a thrown selection failure without an adopted semantic score', async () => {
    const result = await runSelectionCorpus(baseCorpus(), {
      createSelection: () => ({
        async select() {
          throw new Error('boom')
        },
      }),
    })
    const observation = findObservation(result, 'selection-001')
    expect(observation.status).toBe('technical-failure')
    if (observation.status !== 'technical-failure') return
    expect(observation.failure.kind).toBe('threw')
    expect(observation.adoptedScore).toBeNull()
  })

  it('records an aborted selection failure without an adopted semantic score', async () => {
    const result = await runSelectionCorpus(baseCorpus(), {
      createSelection: () => ({
        async select() {
          throw new SelectionCallError('aborted', 'caller revoked')
        },
      }),
    })
    const observation = findObservation(result, 'selection-001')
    expect(observation.status).toBe('technical-failure')
    if (observation.status !== 'technical-failure') return
    expect(observation.failure.kind).toBe('aborted')
    expect(observation.adoptedScore).toBeNull()
  })

  it('records a schema-invalid selection result without an adopted semantic score', async () => {
    const result = await runSelectionCorpus(baseCorpus(), {
      createSelection: () => ({
        async select() {
          return { nope: true } as never
        },
      }),
    })
    const observation = findObservation(result, 'selection-001')
    expect(observation.status).toBe('invalid-result')
    if (observation.status !== 'invalid-result') return
    expect(observation.reason).toBe('schema-invalid')
    expect(observation.adoptedScore).toBeNull()
  })

  it('records a SelectionPort result with zero selected event ids as invalid', async () => {
    const result = await runSelectionCorpus(baseCorpus(), {
      createSelection: () => ({
        async select() {
          return { disposition: 'respond', selectedEventIds: [] } as never
        },
      }),
    })
    const observation = findObservation(result, 'selection-001')
    expect(observation.status).toBe('invalid-result')
    if (observation.status !== 'invalid-result') return
    expect(observation.reason).toBe('exact-one')
  })

  it('records a SelectionPort result with two selected event ids as invalid', async () => {
    const result = await runSelectionCorpus(baseCorpus(), {
      createSelection: () => ({
        async select() {
          return {
            disposition: 'respond',
            selectedEventIds: ['message-001', 'message-002'],
          } as never
        },
      }),
    })
    const observation = findObservation(result, 'selection-001')
    expect(observation.status).toBe('invalid-result')
    if (observation.status !== 'invalid-result') return
    expect(observation.reason).toBe('exact-one')
  })

  it('records an unoffered candidate or disallowed intent as invalid', async () => {
    const base = baseCorpus()
    const request = base.cases[0]!.request
    const unoffered = await runSelectionCorpus(base, {
      createSelection: () => ({
        async select() {
          return fixtureSelectionResult({
            requestId: request.requestId,
            sessionId: request.sessionId,
            epoch: request.epoch,
            snapshotRevision: request.snapshotRevision,
            selectedEventIds: ['not-offered'],
            replyIntent: 'answer',
          })
        },
      }),
    })
    const unofferedObservation = findObservation(unoffered, 'selection-001')
    expect(unofferedObservation.status).toBe('invalid-result')
    if (unofferedObservation.status === 'invalid-result') {
      expect(unofferedObservation.reason).toBe('unoffered-candidate')
    }

    const disallowed = await runSelectionCorpus(base, {
      createSelection: () => ({
        async select() {
          return fixtureSelectionResult({
            requestId: request.requestId,
            sessionId: request.sessionId,
            epoch: request.epoch,
            snapshotRevision: request.snapshotRevision,
            selectedEventIds: ['message-001'],
            replyIntent: 'playful',
          })
        },
      }),
    })
    const disallowedObservation = findObservation(disallowed, 'selection-001')
    expect(disallowedObservation.status).toBe('invalid-result')
    if (disallowedObservation.status === 'invalid-result') {
      expect(disallowedObservation.reason).toBe('intent-not-allowed')
    }
  })

  it('records a synthetic reviewed unsuitable decision with a score of zero', async () => {
    const base = baseCorpus()
    const label = structuredClone(base.cases[0]!.label)
    label.selectionScores = label.selectionScores.map((score) =>
      score.disposition === 'respond' && score.selectedEventIds[0] === 'message-001'
        ? { ...score, score: 0 as const }
        : score,
    )
    const synthetic = createSyntheticReviewedCorpus({
      base,
      labelOverrides: { 'selection-001': label },
    })
    try {
      const corpus = loadDecisionCorpus(synthetic.manifestPath, { allowSynthetic: true })
      const result = await runSelectionCorpus(corpus, {
        ...ruleSelection(),
        allowSynthetic: true,
      })
      const observation = findObservation(result, 'selection-001')
      expect(observation.status).toBe('observed')
      if (observation.status !== 'observed') return
      expect(observation.adoptedScore).toBe(0)
      expect(observation.candidateScore).toBe(0)
      expect(observation.certifiesCorpus).toBe(false)
    } finally {
      synthetic.cleanup()
    }
  })

  it('does not adopt a score from a draft label', async () => {
    const result = await runSelectionCorpus(baseCorpus(), ruleSelection())
    const observation = findObservation(result, 'selection-002')
    expect(observation.status).toBe('observed')
    if (observation.status !== 'observed') return
    expect(observation.labelStatus).toBe('draft')
    expect(observation.scoreStatus).toBe('not-adopted')
    expect(observation.adoptedScore).toBeNull()
    expect(observation.certifiesCorpus).toBe(false)
  })

  it('marks a synthetic reviewed score as non-certifying test evidence', async () => {
    const synthetic = createSyntheticReviewedCorpus({ base: baseCorpus() })
    try {
      const corpus = loadDecisionCorpus(synthetic.manifestPath, { allowSynthetic: true })
      const result = await runSelectionCorpus(corpus, {
        ...ruleSelection(),
        allowSynthetic: true,
      })
      const observation = findObservation(result, 'selection-001')
      expect(observation.status).toBe('observed')
      if (observation.status !== 'observed') return
      expect(observation.evidenceClass).toBe('synthetic-test')
      expect(observation.certifiesCorpus).toBe(false)
      expect(observation.scoreStatus).toBe('adopted')
    } finally {
      synthetic.cleanup()
    }
  })

  it('treats a corpus-loading error as not-run rather than a case failure', async () => {
    const base = baseCorpus()
    const root = mkdtempSync(join(tmpdir(), 'm3-not-run-'))
    try {
      const manifest = {
        ...base.manifest,
        cases: [base.manifest.cases[0]!, base.manifest.cases[0]!],
      }
      const manifestPath = join(root, 'manifest.json')
      writeJson(manifestPath, manifest)
      let calls = 0
      const result = await runSelectionCorpusFromManifest(manifestPath, {
        createSelection: () => ({
          async select() {
            calls += 1
            throw new Error('must not run')
          },
        }),
      })
      expect(result.status).toBe('not-run')
      if (result.status === 'not-run') expect(result.error.code).toBe('duplicate-case-id')
      expect(calls).toBe(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps plan timing and aggregate quality unclaimed', async () => {
    const result = await runSelectionCorpus(baseCorpus(), ruleSelection())
    const observation = findObservation(result, 'selection-001')
    expect(observation.planMs).toBeNull()
    expect(observation.totalMs).toBeNull()
    expect('qualityScore' in observation).toBe(false)
  })
})

describe('M3 NFR-03 rubric artifact', () => {
  it('retains the four NFR-03 dimensions in the rubric artifact', () => {
    const rubric = readFileSync(
      join(process.cwd(), 'docs', 'decision', 'm3-quality-rubric-v0.1.md'),
      'utf8',
    )
    expect(rubric).toContain('Selection appropriateness')
    expect(rubric).toContain('Intent adherence')
    expect(rubric).toContain('Persona consistency')
    expect(rubric).toContain('Unacceptable-response rate')
    expect(rubric).toContain('intent suitability')
    expect(rubric).toContain('not a fifth')
    expect(rubric).toContain('partial')
    expect(rubric).toContain('unassessed')
  })
})
