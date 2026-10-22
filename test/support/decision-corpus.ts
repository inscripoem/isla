import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import type { SelectionRequest } from '../../src/contracts'
import { replyIntentSchema, selectionRequestSchema } from '../../src/contracts'
import type { EvalCase } from '../../src/evaluation/comparison'

/**
 * Test-only corpus loader for M3 selection evidence.
 *
 * The corpus is deliberately separate from the production module. Reference
 * labels and detached review records are loaded here and are never passed to a
 * SelectionPort. Canonical JSON hashing avoids CRLF/LF differences between
 * Windows checkouts and Linux CI.
 */

export type DecisionCorpusErrorCode =
  | 'manifest-invalid'
  | 'path-outside-corpus'
  | 'file-missing'
  | 'duplicate-case-id'
  | 'duplicate-file-path'
  | 'duplicate-candidate-id'
  | 'request-invalid'
  | 'label-invalid'
  | 'label-coverage-incomplete'
  | 'exhaustive-coverage-unjustified'
  | 'review-invalid'
  | 'review-content-mismatch'
  | 'review-provenance-rejected'
  | 'corpus-hash-mismatch'
  | 'case-missing'
  | 'evalcase-anchor-mismatch'

export class DecisionCorpusError extends Error {
  readonly code: DecisionCorpusErrorCode

  constructor(code: DecisionCorpusErrorCode, message: string) {
    super(message)
    this.name = 'DecisionCorpusError'
    this.code = code
  }
}

function fail(code: DecisionCorpusErrorCode, message: string): never {
  throw new DecisionCorpusError(code, message)
}

const caseIdSchema = z
  .string()
  .min(1)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'case ids are lowercase letters, digits and hyphens')

const relativePathSchema = z
  .string()
  .min(1)
  .superRefine((value, context) => {
    if (
      isAbsolute(value) ||
      /^[A-Za-z]:[\\/]/.test(value) ||
      value.replace(/\\/g, '/').split('/').includes('..')
    ) {
      context.addIssue({
        code: 'custom',
        message: 'corpus paths must be relative and must not escape the corpus directory',
      })
    }
  })

const hashSchema = z.string().regex(/^[0-9a-f]{64}$/, 'expected a lowercase SHA-256 hex digest')

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'review dates must use YYYY-MM-DD')
  .refine((value) => Number.isFinite(Date.parse(`${value}T00:00:00Z`)), 'review date is invalid')

export const decisionCorpusManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  hashVersion: z.literal(1),
  corpusVersion: z.string().min(1),
  rubricVersion: z.string().min(1),
  casesSha256: hashSchema,
  cases: z
    .array(
      z.strictObject({
        id: caseIdSchema,
        requestFile: relativePathSchema,
        labelFile: relativePathSchema,
        reviewFile: relativePathSchema,
        initialNowMs: z.number().nonnegative().refine(Number.isFinite, 'initialNowMs must be finite'),
        heldOut: z.boolean(),
        executionMode: z.literal('selection-port'),
      }),
    )
    .min(1),
})
export type DecisionCorpusManifest = z.infer<typeof decisionCorpusManifestSchema>
export type DecisionCorpusManifestCase = DecisionCorpusManifest['cases'][number]

const scoreSchema = z.union([z.literal(0), z.literal(1), z.literal(2)])

const selectionScoreSchema = z
  .strictObject({
    disposition: z.enum(['respond', 'defer']),
    selectedEventIds: z.array(z.string().min(1)),
    score: scoreSchema,
  })
  .superRefine((value, context) => {
    if (value.disposition === 'respond' && value.selectedEventIds.length !== 1) {
      context.addIssue({
        code: 'custom',
        message: 'respond labels require exactly one selected event id',
      })
    }
    if (value.disposition === 'defer' && value.selectedEventIds.length !== 0) {
      context.addIssue({
        code: 'custom',
        message: 'defer labels require no selected event ids',
      })
    }
  })

const intentLabelSchema = z
  .strictObject({
    selectedEventId: z.string().min(1),
    acceptableIntents: z.array(replyIntentSchema).min(1),
    coverage: z.enum(['partial', 'exhaustive']),
    coverageRationale: z.string().min(1).nullable(),
  })
  .superRefine((value, context) => {
    if (
      value.coverage === 'exhaustive' &&
      (value.coverageRationale === null || value.coverageRationale.trim().length === 0)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'exhaustive intent coverage requires a reviewed coverageRationale',
      })
    }
  })

export const decisionReferenceLabelSchema = z.strictObject({
  caseId: caseIdSchema,
  selectionScores: z.array(selectionScoreSchema).min(1),
  intentLabels: z.array(intentLabelSchema),
  rationale: z.string().min(1),
})
export type DecisionReferenceLabel = z.infer<typeof decisionReferenceLabelSchema>

const draftReviewSchema = z.strictObject({
  caseId: caseIdSchema,
  status: z.literal('draft'),
  notes: z.string().min(1).optional(),
})

const reviewedReviewSchema = z.strictObject({
  caseId: caseIdSchema,
  status: z.literal('reviewed'),
  provenance: z.enum(['human', 'synthetic-test']),
  reviewerId: z.string().min(1),
  reviewedAt: dateSchema,
  requestSha256: hashSchema,
  labelSha256: hashSchema,
  notes: z.string().min(1).optional(),
})

export const decisionReviewRecordSchema = z.discriminatedUnion('status', [
  draftReviewSchema,
  reviewedReviewSchema,
])
export type DecisionReviewRecord = z.infer<typeof decisionReviewRecordSchema>

export interface LoadedDecisionCorpusCase {
  readonly entry: DecisionCorpusManifestCase
  readonly request: SelectionRequest
  readonly label: DecisionReferenceLabel
  readonly review: DecisionReviewRecord
  readonly corpusVersion: string
  readonly rubricVersion: string
}

export interface LoadedDecisionCorpus {
  readonly root: string
  readonly manifest: DecisionCorpusManifest
  readonly cases: readonly LoadedDecisionCorpusCase[]
  readonly casesSha256: string
}

export interface LoadDecisionCorpusOptions {
  /**
   * Synthetic reviewed records are permitted only for mechanics tests. A real
   * corpus must never use them as evidence.
   */
  readonly allowSynthetic?: boolean
}

function formatIssues(error: {
  readonly issues: ReadonlyArray<{
    readonly path: ReadonlyArray<PropertyKey>
    readonly message: string
  }>
}): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.map((part) => String(part)).join('.')
      return `${path === '' ? '(root)' : path}: ${issue.message}`
    })
    .join('; ')
}

function readJsonFile(file: string, code: DecisionCorpusErrorCode): unknown {
  if (!existsSync(file)) fail('file-missing', `corpus file is missing: ${file}`)
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    fail(code, `corpus file could not be read: ${file}: ${String(error)}`)
  }
  try {
    return JSON.parse(text) as unknown
  } catch (error) {
    fail(code, `corpus file is not valid JSON: ${file}: ${String(error)}`)
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(record).sort()) sorted[key] = canonicalize(record[key])
    return sorted
  }
  return value
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

export function contentSha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')
}

export interface DecisionCorpusHashCase {
  readonly entry: DecisionCorpusManifestCase
  readonly request: SelectionRequest
  readonly label: DecisionReferenceLabel
  readonly review: DecisionReviewRecord
}

export interface DecisionCorpusHashInput {
  readonly corpusVersion: string
  readonly rubricVersion: string
  readonly cases: readonly DecisionCorpusHashCase[]
}

/**
 * Content hash over the manifest semantics plus canonical request, label and
 * review content. The manifest's own casesSha256 is deliberately excluded.
 */
export function computeCasesSha256(input: DecisionCorpusHashInput): string {
  const cases = [...input.cases]
    .sort((left, right) =>
      left.entry.id < right.entry.id ? -1 : left.entry.id > right.entry.id ? 1 : 0,
    )
    .map(({ entry, request, label, review }) => ({
      id: entry.id,
      requestFile: entry.requestFile,
      requestSha256: contentSha256(request),
      labelFile: entry.labelFile,
      labelSha256: contentSha256(label),
      reviewFile: entry.reviewFile,
      reviewSha256: contentSha256(review),
      initialNowMs: entry.initialNowMs,
      heldOut: entry.heldOut,
      executionMode: entry.executionMode,
    }))

  return contentSha256({
    schemaVersion: 1,
    hashVersion: 1,
    corpusVersion: input.corpusVersion,
    rubricVersion: input.rubricVersion,
    cases,
  })
}

function insideCorpus(root: string, relativePath: string): string {
  const full = resolve(root, relativePath)
  const relation = relative(root, full)
  if (
    relation === '' ||
    relation === '..' ||
    relation.startsWith(`..${sep}`) ||
    isAbsolute(relation)
  ) {
    fail(
      'path-outside-corpus',
      `corpus path escapes ${root}: ${relativePath}`,
    )
  }
  return full
}

function assertUniquePaths(cases: readonly DecisionCorpusManifestCase[]): void {
  const seen = new Set<string>()
  for (const entry of cases) {
    for (const file of [entry.requestFile, entry.labelFile, entry.reviewFile]) {
      const key = file.replace(/\\/g, '/')
      if (seen.has(key)) {
        fail('duplicate-file-path', `corpus file is used by more than one case: ${file}`)
      }
      seen.add(key)
    }
  }
}

function assertUniqueCaseIds(cases: readonly DecisionCorpusManifestCase[]): void {
  const seen = new Set<string>()
  for (const entry of cases) {
    if (seen.has(entry.id)) fail('duplicate-case-id', `duplicate corpus case id: ${entry.id}`)
    seen.add(entry.id)
  }
}

function parseRequest(file: string, entry: DecisionCorpusManifestCase): SelectionRequest {
  const parsed = selectionRequestSchema.safeParse(readJsonFile(file, 'request-invalid'))
  if (!parsed.success) {
    fail('request-invalid', `${entry.requestFile}: ${formatIssues(parsed.error)}`)
  }
  const request = parsed.data
  const seen = new Set<string>()
  for (const candidate of request.candidates) {
    if (seen.has(candidate.eventId)) {
      fail(
        'duplicate-candidate-id',
        `${entry.requestFile}: duplicate offered candidate event id ${candidate.eventId}`,
      )
    }
    seen.add(candidate.eventId)
    if (candidate.sessionId !== request.sessionId || candidate.epoch !== request.epoch) {
      fail(
        'request-invalid',
        `${entry.requestFile}: candidate ${candidate.eventId} does not belong to the request session/epoch`,
      )
    }
    if (!Number.isFinite(candidate.receivedAtMs) || !Number.isFinite(candidate.expiresAtMs)) {
      fail('request-invalid', `${entry.requestFile}: candidate times must be finite`)
    }
    if (candidate.receivedAtMs > entry.initialNowMs) {
      fail(
        'request-invalid',
        `${entry.requestFile}: candidate ${candidate.eventId} was received after initialNowMs`,
      )
    }
    if (candidate.expiresAtMs <= entry.initialNowMs) {
      fail(
        'request-invalid',
        `${entry.requestFile}: candidate ${candidate.eventId} is expired at initialNowMs`,
      )
    }
  }
  if (!Number.isFinite(request.deadline.atMs) || request.deadline.atMs <= entry.initialNowMs) {
    fail(
      'request-invalid',
      `${entry.requestFile}: request deadline must be finite and later than initialNowMs`,
    )
  }
  return request
}

function parseLabel(
  file: string,
  entry: DecisionCorpusManifestCase,
  request: SelectionRequest,
  review: DecisionReviewRecord,
): DecisionReferenceLabel {
  const parsed = decisionReferenceLabelSchema.safeParse(readJsonFile(file, 'label-invalid'))
  if (!parsed.success) {
    fail('label-invalid', `${entry.labelFile}: ${formatIssues(parsed.error)}`)
  }
  const label = parsed.data
  if (label.caseId !== entry.id) {
    fail('label-invalid', `${entry.labelFile}: label caseId ${label.caseId} does not match ${entry.id}`)
  }

  const offered = new Set(request.candidates.map((candidate) => candidate.eventId))
  const outcomes = new Set<string>()
  for (const score of label.selectionScores) {
    for (const selected of score.selectedEventIds) {
      if (!offered.has(selected)) {
        fail('label-invalid', `${entry.labelFile}: label names unoffered candidate ${selected}`)
      }
    }
    const key = `${score.disposition}:${[...score.selectedEventIds].join(',')}`
    if (outcomes.has(key)) {
      fail('label-invalid', `${entry.labelFile}: duplicate selection outcome ${key}`)
    }
    outcomes.add(key)
  }

  const intentCandidates = new Set<string>()
  for (const intentLabel of label.intentLabels) {
    if (!offered.has(intentLabel.selectedEventId)) {
      fail(
        'label-invalid',
        `${entry.labelFile}: intent label names unoffered candidate ${intentLabel.selectedEventId}`,
      )
    }
    if (intentCandidates.has(intentLabel.selectedEventId)) {
      fail(
        'label-invalid',
        `${entry.labelFile}: duplicate intent label for ${intentLabel.selectedEventId}`,
      )
    }
    intentCandidates.add(intentLabel.selectedEventId)
    for (const intent of intentLabel.acceptableIntents) {
      if (!request.allowedIntents.includes(intent)) {
        fail(
          'label-invalid',
          `${entry.labelFile}: intent ${intent} is outside request.allowedIntents`,
        )
      }
    }
    if (intentLabel.coverage === 'exhaustive') {
      if (review.status !== 'reviewed') {
        fail(
          'exhaustive-coverage-unjustified',
          `${entry.labelFile}: exhaustive intent coverage requires a reviewed record`,
        )
      }
      if (
        intentLabel.coverageRationale === null ||
        intentLabel.coverageRationale.trim().length === 0
      ) {
        fail(
          'exhaustive-coverage-unjustified',
          `${entry.labelFile}: exhaustive intent coverage requires a rationale`,
        )
      }
    }
  }

  if (review.status === 'reviewed') {
    const respondIds = new Set(
      label.selectionScores
        .filter((score) => score.disposition === 'respond')
        .map((score) => score.selectedEventIds[0]!),
    )
    for (const candidate of request.candidates) {
      if (!respondIds.has(candidate.eventId)) {
        fail(
          'label-coverage-incomplete',
          `${entry.labelFile}: reviewed label does not score offered candidate ${candidate.eventId}`,
        )
      }
    }
    if (!label.selectionScores.some((score) => score.disposition === 'defer')) {
      fail('label-coverage-incomplete', `${entry.labelFile}: reviewed label does not score defer`)
    }
  }

  return label
}

function parseReviewRecord(
  file: string,
  entry: DecisionCorpusManifestCase,
  allowSynthetic: boolean,
): DecisionReviewRecord {
  const parsed = decisionReviewRecordSchema.safeParse(readJsonFile(file, 'review-invalid'))
  if (!parsed.success) {
    fail('review-invalid', `${entry.reviewFile}: ${formatIssues(parsed.error)}`)
  }
  const review = parsed.data
  if (review.caseId !== entry.id) {
    fail('review-invalid', `${entry.reviewFile}: review caseId ${review.caseId} does not match ${entry.id}`)
  }
  if (
    review.status === 'reviewed' &&
    review.provenance === 'synthetic-test' &&
    !allowSynthetic
  ) {
    fail(
      'review-provenance-rejected',
      `${entry.reviewFile}: synthetic review records cannot certify a real corpus`,
    )
  }
  return review
}

function assertReviewContent(
  review: DecisionReviewRecord,
  request: SelectionRequest,
  label: DecisionReferenceLabel,
  entry: DecisionCorpusManifestCase,
): void {
  if (review.status !== 'reviewed') return
  if (review.requestSha256 !== contentSha256(request)) {
    fail(
      'review-content-mismatch',
      `${entry.reviewFile}: request content changed after review`,
    )
  }
  if (review.labelSha256 !== contentSha256(label)) {
    fail(
      'review-content-mismatch',
      `${entry.reviewFile}: label content changed after review`,
    )
  }
}

export function loadDecisionCorpus(
  manifestPath: string,
  options: LoadDecisionCorpusOptions = {},
): LoadedDecisionCorpus {
  const root = dirname(resolve(manifestPath))
  const parsed = decisionCorpusManifestSchema.safeParse(
    readJsonFile(manifestPath, 'manifest-invalid'),
  )
  if (!parsed.success) {
    fail('manifest-invalid', `${manifestPath}: ${formatIssues(parsed.error)}`)
  }
  const manifest = parsed.data
  assertUniqueCaseIds(manifest.cases)
  assertUniquePaths(manifest.cases)

  const cases: LoadedDecisionCorpusCase[] = []
  for (const entry of manifest.cases) {
    const requestFile = insideCorpus(root, entry.requestFile)
    const labelFile = insideCorpus(root, entry.labelFile)
    const reviewFile = insideCorpus(root, entry.reviewFile)

    const request = parseRequest(requestFile, entry)
    const review = parseReviewRecord(reviewFile, entry, options.allowSynthetic === true)
    const label = parseLabel(labelFile, entry, request, review)
    assertReviewContent(review, request, label, entry)
    cases.push({
      entry,
      request,
      label,
      review,
      corpusVersion: manifest.corpusVersion,
      rubricVersion: manifest.rubricVersion,
    })
  }

  const casesSha256 = computeCasesSha256({
    corpusVersion: manifest.corpusVersion,
    rubricVersion: manifest.rubricVersion,
    cases,
  })
  if (casesSha256 !== manifest.casesSha256) {
    fail(
      'corpus-hash-mismatch',
      `${manifestPath}: casesSha256 does not match the corpus content`,
    )
  }

  return { root, manifest, cases, casesSha256 }
}

export function findDecisionCase(
  corpus: LoadedDecisionCorpus,
  caseId: string,
): LoadedDecisionCorpusCase {
  const found = corpus.cases.find((entry) => entry.entry.id === caseId)
  if (found === undefined) fail('case-missing', `corpus ${corpus.manifest.corpusVersion} has no case ${caseId}`)
  return found
}

/**
 * M6's EvalCase envelope. `input` is an anchor to the first offered candidate;
 * the full request is loaded from the corpus, never reconstructed from it.
 */
export function toEvalCase(
  entry: DecisionCorpusManifestCase,
  request: SelectionRequest,
): EvalCase {
  const first = request.candidates[0]
  if (first === undefined || first.text.trim().length === 0) {
    fail('evalcase-anchor-mismatch', `case ${entry.id} has no first candidate text`)
  }
  return {
    id: entry.id,
    input: first.text,
    heldOut: entry.heldOut,
  }
}
