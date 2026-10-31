import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { SelectionRequest } from '../../src/contracts'
import type {
  DecisionReferenceLabel,
  DecisionReviewRecord,
  LoadedDecisionCorpus,
} from './decision-corpus'
import { computeCasesSha256, contentSha256 } from './decision-corpus'

/**
 * Synthetic reviewed corpus for mechanics tests only.
 *
 * The review record is intentionally marked `provenance: "synthetic-test"`.
 * It may test reviewed-path validation and scoring mechanics, but it can never
 * certify a committed corpus example. Real examples remain draft until a named
 * human reviewer signs them.
 */
export interface SyntheticReviewedCorpusOptions {
  readonly base: LoadedDecisionCorpus
  readonly reviewedCaseIds?: readonly string[]
  readonly requestOverrides?: Readonly<Record<string, SelectionRequest>>
  readonly labelOverrides?: Readonly<Record<string, DecisionReferenceLabel>>
}

export interface SyntheticReviewedCorpus {
  readonly root: string
  readonly manifestPath: string
  cleanup(): void
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

export function createSyntheticReviewedCorpus(
  options: SyntheticReviewedCorpusOptions,
): SyntheticReviewedCorpus {
  const { base } = options
  const reviewed = new Set(
    options.reviewedCaseIds ?? [base.cases[0]?.entry.id].filter((id): id is string => id !== undefined),
  )
  const root = mkdtempSync(join(tmpdir(), 'm3-synthetic-corpus-'))
  const cases = base.manifest.cases.map((entry) => {
    const loaded = base.cases.find((candidate) => candidate.entry.id === entry.id)
    if (loaded === undefined) throw new Error(`base corpus has no case ${entry.id}`)
    const request = options.requestOverrides?.[entry.id] ?? loaded.request
    const label = options.labelOverrides?.[entry.id] ?? loaded.label
    const review: DecisionReviewRecord = reviewed.has(entry.id)
      ? {
          caseId: entry.id,
          status: 'reviewed',
          provenance: 'synthetic-test',
          reviewerId: 'synthetic-test-reviewer',
          reviewedAt: '2026-10-23',
          requestSha256: contentSha256(request),
          labelSha256: contentSha256(label),
          notes: 'Synthetic test data. This is not a human review and cannot certify corpus evidence.',
        }
      : loaded.review

    writeJson(join(root, entry.requestFile), request)
    writeJson(join(root, entry.labelFile), label)
    writeJson(join(root, entry.reviewFile), review)
    return { entry, request, label, review }
  })

  const manifest = {
    ...base.manifest,
    casesSha256: computeCasesSha256({
      corpusVersion: base.manifest.corpusVersion,
      rubricVersion: base.manifest.rubricVersion,
      cases,
    }),
  }
  const manifestPath = join(root, 'manifest.json')
  writeJson(manifestPath, manifest)

  return {
    root,
    manifestPath,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}
