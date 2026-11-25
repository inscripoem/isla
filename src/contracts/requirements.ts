import { z } from 'zod'
import { nonEmptyString } from './app/primitives'

const roleSchema = z.enum(['M1', 'M2', 'M3', 'M4', 'M5', 'M6'])

const acceptanceSchema = z.strictObject({
  kind: z.enum(['deterministic', 'pending-metric']),
  description: nonEmptyString,
  /** Referenced C-case IDs for deterministic first-slice acceptance. */
  cases: z.array(nonEmptyString),
})

export const requirementCategorySchema = z.enum([
  'functional',
  'invariant',
  'security',
  'governance',
  'performance',
  'cost',
  'quality',
])

// Optional in the generated JSON Schema; test/offline/requirements.test.ts enforces presence for every
// non-functional requirement. The JSON Schema is structural; the readiness test is the conditional rule.
export const requirementSubtypeSchema = z.enum([
  'authority',
  'safety',
  'data-integrity',
  'audit-integrity',
  'reliability',
  'correctness',
  'privacy',
  'access-control',
  'retention',
  'traceability',
  'audit',
  'evaluation',
  'latency',
  'efficiency',
  'token-cost',
  'response-quality',
  'modifiability',
])

export const requirementSchema = z.strictObject({
  id: nonEmptyString,
  title: nonEmptyString,
  category: requirementCategorySchema,
  subtype: requirementSubtypeSchema.optional(),
  priority: z.enum(['must', 'should', 'could', 'wont']),
  owner: roleSchema,
  collaborators: z.array(roleSchema),
  source: nonEmptyString,
  status: z.enum(['under-review', 'approved', 'pending-measurement']),
  acceptance: z.array(acceptanceSchema).min(1),
})
export type Requirement = z.infer<typeof requirementSchema>

export const requirementsRegistrySchema = z
  .strictObject({
    version: z.literal('0.3'),
    generatedFrom: nonEmptyString,
    requirements: z.array(requirementSchema).min(1),
  })
  .superRefine((value, context) => {
    const seen = new Set<string>()
    for (const requirement of value.requirements) {
      if (seen.has(requirement.id)) {
        context.addIssue({ code: 'custom', message: `duplicate requirement id ${requirement.id}` })
      }
      seen.add(requirement.id)
    }
  })
export type RequirementsRegistry = z.infer<typeof requirementsRegistrySchema>

export function requirementsJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(requirementsRegistrySchema, { io: 'input' }) as Record<string, unknown>
}

/**
 * Explicit case-to-test registry. A deterministic case must name a real test
 * file and a check/test string present in it; a pending case carries no
 * verifier and cannot be used as deterministic evidence.
 */
export const caseEntrySchema = z.strictObject({
  id: nonEmptyString,
  status: z.enum(['implemented', 'pending']),
  title: nonEmptyString,
  verifier: z
    .strictObject({
      file: nonEmptyString,
      test: nonEmptyString,
    })
    .nullable(),
})
export type CaseEntry = z.infer<typeof caseEntrySchema>

export const caseRegistrySchema = z
  .strictObject({
    version: z.literal('0.2'),
    cases: z.array(caseEntrySchema).min(1),
  })
  .superRefine((value, context) => {
    const seen = new Set<string>()
    for (const entry of value.cases) {
      if (seen.has(entry.id)) {
        context.addIssue({ code: 'custom', message: `duplicate case id ${entry.id}` })
      }
      seen.add(entry.id)
    }
  })
export type CaseRegistry = z.infer<typeof caseRegistrySchema>

export function casesJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(caseRegistrySchema, { io: 'input' }) as Record<string, unknown>
}
