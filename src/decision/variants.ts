/**
 * M3 comparison variants for NFR-03 / Issue #98.
 *
 * The identifiers are stable labels for the measurement bench. Each variant is
 * deliberately described by only `id`, `kind` and `combined` so it satisfies the
 * shared comparison `Variant` shape and the strict recorded-run key check.
 */

export const DECISION_VARIANT_IDS = [
  'm3-rules',
  'm3-general-model',
  'm3-jev',
  'm3-m4-combined',
] as const

export type DecisionVariantId = (typeof DECISION_VARIANT_IDS)[number]

export interface DecisionComparisonVariant {
  readonly id: DecisionVariantId
  readonly kind: 'rules' | 'model'
  readonly combined: boolean
}

export const M3_COMPARISON_VARIANTS: readonly DecisionComparisonVariant[] = [
  { id: 'm3-rules', kind: 'rules', combined: false },
  { id: 'm3-general-model', kind: 'model', combined: false },
  { id: 'm3-jev', kind: 'model', combined: false },
  { id: 'm3-m4-combined', kind: 'model', combined: true },
]

export const M3_COMPARISON_VARIANT_DESCRIPTIONS: Readonly<
  Record<DecisionVariantId, string>
> = {
  'm3-rules':
    'Deterministic rules baseline for NFR-03 and Issue #98. It exercises the split M3 selection and reaction ports without a provider call, so it measures the local decision path rather than model quality.',
  'm3-general-model':
    'General OpenAI-compatible model baseline for NFR-03 and Issue #98. It runs the split M3 selection and reaction adapters against a general-purpose provider model and records the served model and measured usage honestly.',
  'm3-jev':
    'Jev dedicated model variant for NFR-03 and Issue #98. It runs the split M3 selection and reaction adapters against the dedicated Jev model configuration so that variant can be compared with the rules and general-model baselines.',
  'm3-m4-combined':
    'Single combined selection+dialogue baseline for NFR-03 and Issue #98. It requires full-turn composition because one call covers both decision and dialogue; it is not a selection-port-only mode and must not be run through that harness.',
}
