import type { EvalCase, Variant, VariantRun } from '../../src/evaluation/comparison'

/**
 * Test-only evaluation harness for the run command.
 *
 * It supplies the two things a deployment harness must supply — variants and the
 * `runVariant` seam — with no provider, no runtime composition and no product
 * code. Every record is completed and no case is skipped, so the command's
 * orchestration is what the test measures.
 */
const VARIANT: Variant = { id: 'fake-rules', kind: 'rules', combined: false }

export default function createFakeHarness() {
  return {
    variants: [VARIANT],
    async runVariant(_variant: Variant, evalCase: EvalCase): Promise<VariantRun> {
      return {
        ran: true,
        record: {
          caseId: evalCase.id,
          variantId: VARIANT.id,
          cold: false,
          outcome: 'completed',
          timing: {
            submitMs: null,
            planMs: null,
            dialogueMs: null,
            synthesisMs: null,
            firstAudibleMs: null,
            stopToSilenceMs: null,
          },
          totalMs: null,
          attempts: 1,
          usage: { inputTokens: 10, outputTokens: 5, costUsd: null, usageMissing: false },
          failureReason: null,
        },
      }
    },
  }
}
