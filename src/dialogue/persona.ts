import type { ReplyIntent } from '../contracts'

/**
 * Character profiles and the deterministic intent-to-dialogue mapping.
 *
 * M4-01 replaces the language model with a fixed table so the pipeline can be
 * integrated and tested without a live provider. M4-02 swaps the table for a
 * real model call; the surrounding generation, cancellation and memory
 * behaviour must not change when that happens.
 */

export interface CharacterProfile {
  profileId: string
  version: string
  personaSummary: string
  styleNotes: readonly string[]
}

/**
 * Built-in profiles. `character-fixture` is the profile used by the shared
 * offline fixtures, so it must stay registered for the suite to run.
 */
export const DEFAULT_CHARACTER_PROFILES: readonly CharacterProfile[] = [
  {
    profileId: 'character-fixture',
    version: '1',
    personaSummary: 'A concise, friendly character.',
    styleNotes: ['keeps replies short', 'speaks in at most two segments'],
  },
]

/**
 * Resolves a profile by identity and version. Both must match: a profile
 * version change is a different persona and must not be silently substituted.
 * Returns null for an unknown profile, which the caller reports as a failed
 * generation rather than inventing a persona.
 */
export function resolveCharacterProfile(
  profileId: string,
  version: string,
  profiles: readonly CharacterProfile[] = DEFAULT_CHARACTER_PROFILES,
): CharacterProfile | null {
  return (
    profiles.find((profile) => profile.profileId === profileId && profile.version === version) ??
    null
  )
}

/**
 * Fixed reply lines per reply intent, in speaking order.
 *
 * `check-correction` deliberately asks for verification instead of agreeing:
 * the contract requires the intent to request verification, not to concede.
 */
export const INTENT_REPLY_LINES: Readonly<Record<ReplyIntent, readonly string[]>> = {
  answer: ['We talked about the concert.', 'It was loud and fun.'],
  clarify: ['Which part should I start with?'],
  acknowledge: ['Thanks for saying that.'],
  support: ['That sounds rough, but you have got this.'],
  playful: ['I would rate it eleven out of ten.'],
  'check-correction': ['Let me double-check that before I agree.'],
}

export function replyLinesForIntent(intent: ReplyIntent): readonly string[] {
  return INTENT_REPLY_LINES[intent]
}
