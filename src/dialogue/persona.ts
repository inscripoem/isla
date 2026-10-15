import { REPLY_INTENTS } from '../contracts'
import type { ReplyIntent } from '../contracts'
import { CHARACTER_CONTENT, PERSONA_AUTHORING_STATUS } from './persona-content'
import type { PersonaContent } from './persona-content'
import { isSubstantiveSpeech } from './text'

/**
 * Character profiles and their mapping into context.
 *
 * Two configuration origins coexist and are never mixed:
 *   - `harness` - the offline fixture profile, which lets the shared conformance
 *     kit run without an authored character. It is not a real character; do not
 *     edit it to improve the character's tone.
 *   - `author` - the authored character, read from ./content and maintained by the
 *     character author. Nothing here rewrites or defaults over its wording.
 *
 * M4-01 uses a fixed table so the pipeline can be integrated and tested with no
 * online provider. M4-02 replaces the table with real model calls, while the
 * resolution, validation and rendering logic below stays the same.
 */

/**
 * Cap on standing facts rendered every turn.
 *
 * `standingFacts` shares one character budget with confirmed history, so an
 * unbounded list would crowd out the memory it is meant to support. Enforced by
 * validation once the character is marked ready; a draft only reports issues.
 */
export const MAX_STANDING_FACTS = 5
/**
 * Character cap for a single standing fact.
 *
 * 110 rather than a smaller value: a fact has to state both its subject and its
 * relation to avoid being misread, and over-compressing degrades it into a vague
 * label. The real constraint is the total of `count x length`, and the count cap
 * already seals the worst case (5 x 110 = 550 characters, roughly a quarter of the
 * default 2000-character budget).
 */
export const MAX_STANDING_FACT_CHARACTERS = 110

export interface CharacterProfile {
  profileId: string
  version: string
  personaSummary: string
  styleNotes: readonly string[]
  /** Facts that must hold on every turn; absent means no standing facts. */
  standingFacts?: readonly string[]
  /** An absent field means the character has nothing to say for any intent. */
  intentTemplates?: Readonly<Record<ReplyIntent, readonly string[]>>
  boundaries?: readonly string[]
  /**
   * A `harness` profile is test scaffolding; an `author` profile comes from
   * ./content. Validation reports the origin so a fixture character is never
   * mistaken for the authored one.
   */
  origin: 'harness' | 'author'
}

/**
 * The profile the shared offline kit needs. `character-fixture` must stay
 * registered and keep producing valid text, or the conformance suite loses its
 * baseline instead of discovering a real defect.
 */
const FIXTURE_INTENT_REPLY_LINES: Readonly<Record<ReplyIntent, readonly string[]>> = {
  answer: ['We talked about the concert.', 'It was loud and fun.'],
  clarify: ['Which part should I start with?'],
  acknowledge: ['Thanks for saying that.'],
  support: ['That sounds rough, but you have got this.'],
  playful: ['I would rate it eleven out of ten.'],
  // Asks for verification instead of agreeing outright: the contract requires this
  // intent to request checking, not to accept the correction directly.
  'check-correction': ['Let me double-check that before I agree.'],
}

export const FIXTURE_CHARACTER_PROFILE: CharacterProfile = {
  profileId: 'character-fixture',
  version: '1',
  personaSummary: 'A concise, friendly character.',
  styleNotes: ['keeps replies short', 'speaks in at most two segments'],
  intentTemplates: FIXTURE_INTENT_REPLY_LINES,
  origin: 'harness',
}

export const AUTHOR_CHARACTER_PROFILE: CharacterProfile = {
  profileId: CHARACTER_CONTENT.profileId,
  version: CHARACTER_CONTENT.version,
  personaSummary: CHARACTER_CONTENT.personaSummary,
  styleNotes: CHARACTER_CONTENT.styleNotes,
  standingFacts: CHARACTER_CONTENT.standingFacts,
  intentTemplates: CHARACTER_CONTENT.intentTemplates,
  boundaries: CHARACTER_CONTENT.boundaries,
  origin: 'author',
}

export const DEFAULT_CHARACTER_PROFILES: readonly CharacterProfile[] = [
  FIXTURE_CHARACTER_PROFILE,
  AUTHOR_CHARACTER_PROFILE,
]

/**
 * Character identity used for memory versioning. Both parts matter: the same
 * version number under a different profile id is a different character. Memory
 * records store this key so words spoken by a superseded character stay
 * identifiable afterwards.
 */
export function personaVersionKey(profileId: string, version: string): string {
  return `${profileId}@${version}`
}

/**
 * Resolve a profile by identity and version. Both must match: a changed profile
 * version means the character changed and must not be substituted silently. An
 * unknown profile returns null, and the caller reports a generation failure rather
 * than inventing a character.
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
 * Reply lines for one intent, in speaking order. An empty array has a definite
 * meaning: the character has nothing to say, and the caller must turn that into a
 * voiceless result rather than improvising a filler line.
 */
export function intentTemplatesFor(
  profile: CharacterProfile,
  intent: ReplyIntent,
): readonly string[] {
  return profile.intentTemplates?.[intent] ?? []
}

/**
 * Placeholder markers that must not appear in a ready character. A character that
 * ships still saying "TODO" is worse than a missing one, because it looks authored
 * while being unfinished.
 *
 * The CJK marker is data, not a comment: it detects an author who was writing in
 * Chinese and left the slot unfilled.
 */
export const PERSONA_PLACEHOLDER_MARKERS: readonly string[] = [
  'TODO',
  'FIXME',
  'FILL ME',
  'PLACEHOLDER',
  '待填',
]

/**
 * Machine-readable markers on bible entries.
 *
 * The bible (`sourceDocument`) and `standingFacts` are two copies of the same
 * claims, and only the latter reaches the runtime. Without a marker, a divergence
 * between them raises nothing at all - the bible quietly becomes a stale document,
 * and reviewers read something different from what the model reads. `[S]` turns
 * that into something testable: see `standingFactsFromBible`.
 */
export const BIBLE_MARKERS = {
  /** Standing: must appear verbatim in `standingFacts`. */
  standing: '[S]',
  /** Recall candidate: the pool for future on-demand retrieval, not yet prompted. */
  recall: '[R]',
  /** Human-only: for reviewers and the author, never rendered. */
  human: '[H]',
} as const

/**
 * Extract every entry marked `[S]` from the bible body.
 *
 * Parsing only, no judgement: whether the two copies agree is left to a test, so a
 * divergence becomes a build failure instead of a log nobody reads.
 *
 * Only markers inside a blockquote (a line starting with `>`) are accepted: an
 * `[S]` in prose is documentation, not a fact. Entries longer than
 * `MAX_STANDING_FACT_CHARACTERS` are reported explicitly, because an over-long
 * entry usually means the author wrapped the line in the bible, and a wrapped line
 * will not compare equal to the single-line standing fact.
 */
export function standingFactsFromBible(bible: string): readonly string[] {
  const facts: string[] = []
  for (const rawLine of bible.split(/\r?\n/)) {
    if (!/^\s*>/.test(rawLine)) continue
    const marker = rawLine.indexOf(BIBLE_MARKERS.standing)
    if (marker === -1) continue
    const text = rawLine
      .slice(marker + BIBLE_MARKERS.standing.length)
      .replace(/^[\s>*-]+/, '')
      .trim()
    if (text.length > 0) facts.push(text)
  }
  return facts
}

function hasPlaceholder(text: string): boolean {
  const upper = text.toUpperCase()
  return PERSONA_PLACEHOLDER_MARKERS.some((marker) => upper.includes(marker))
}

/**
 * Validate authored character content. Returns a readable list of problems and
 * never throws: a draft is allowed to be incomplete, and reporting problems beats
 * crashing the suite while the author is still writing.
 *
 * Once `PERSONA_AUTHORING_STATUS` is 'ready', the same checks become mandatory.
 */
export function collectPersonaContentIssues(content: PersonaContent): readonly string[] {
  const issues: string[] = []

  if (content.sourceDocument.trim().length === 0 || hasPlaceholder(content.sourceDocument)) {
    issues.push('sourceDocument is missing: the persona must point at its character bible')
  }
  if (content.sourceVersion.trim().length === 0 || hasPlaceholder(content.sourceVersion)) {
    issues.push('sourceVersion is missing or still a placeholder')
  }
  if (content.profileId.trim().length === 0 || hasPlaceholder(content.profileId)) {
    issues.push('profileId is missing or still a placeholder')
  }
  if (content.personaSummary.trim().length === 0 || hasPlaceholder(content.personaSummary)) {
    issues.push('personaSummary is missing or still a placeholder')
  }
  if (content.styleNotes.length === 0) {
    issues.push('styleNotes is empty')
  }
  for (const note of content.styleNotes) {
    if (note.trim().length === 0 || hasPlaceholder(note)) {
      issues.push(`styleNotes contains an empty or placeholder entry: "${note}"`)
    }
  }
  if (content.standingFacts.length === 0) {
    issues.push('standingFacts is empty: nothing is guaranteed to hold on every turn')
  }
  if (content.standingFacts.length > MAX_STANDING_FACTS) {
    issues.push(
      `standingFacts has ${content.standingFacts.length} entries, at most ${MAX_STANDING_FACTS} are allowed`,
    )
  }
  for (const fact of content.standingFacts) {
    if (fact.trim().length === 0 || hasPlaceholder(fact)) {
      issues.push(`standingFacts contains an empty or placeholder entry: "${fact}"`)
    }
    if (fact.length > MAX_STANDING_FACT_CHARACTERS) {
      issues.push(
        `standingFacts entry exceeds ${MAX_STANDING_FACT_CHARACTERS} characters: "${fact}"`,
      )
    }
  }
  if (content.boundaries.length === 0) {
    issues.push('boundaries is empty')
  }
  for (const boundary of content.boundaries) {
    if (boundary.trim().length === 0 || hasPlaceholder(boundary)) {
      issues.push(`boundaries contains an empty or placeholder entry: "${boundary}"`)
    }
  }

  for (const intent of REPLY_INTENTS) {
    const lines = content.intentTemplates[intent]
    if (lines === undefined) {
      issues.push(`intentTemplates is missing the "${intent}" intent`)
      continue
    }
    if (lines.length === 0) {
      issues.push(`intentTemplates["${intent}"] is empty: the character would say nothing`)
      continue
    }
    for (const line of lines) {
      if (!isSubstantiveSpeech(line)) {
        issues.push(`intentTemplates["${intent}"] has a line with no speakable content: "${line}"`)
      }
      if (hasPlaceholder(line)) {
        issues.push(`intentTemplates["${intent}"] still contains a placeholder: "${line}"`)
      }
    }
  }

  return issues
}

export function personaAuthoringStatus(): 'draft' | 'ready' {
  return PERSONA_AUTHORING_STATUS
}

/** Problems with the authored character; expected to be empty once marked ready. */
export function personaAuthoringIssues(): readonly string[] {
  return collectPersonaContentIssues(CHARACTER_CONTENT)
}

/**
 * Render a character as a context block. Empty sections are omitted rather than
 * rendered as empty headings, because every line here costs context space on every
 * single turn.
 */
export function renderPersonaBlock(profile: CharacterProfile): string {
  const lines: string[] = [`Persona: ${profile.personaSummary}`]

  if (profile.styleNotes.length > 0) {
    lines.push('Style:')
    for (const note of profile.styleNotes) lines.push(`- ${note}`)
  }
  const standingFacts = (profile.standingFacts ?? []).slice(0, MAX_STANDING_FACTS)
  if (standingFacts.length > 0) {
    lines.push('Always true:')
    for (const fact of standingFacts) lines.push(`- ${fact}`)
  }
  const boundaries = profile.boundaries ?? []
  if (boundaries.length > 0) {
    lines.push('Never:')
    for (const boundary of boundaries) lines.push(`- ${boundary}`)
  }

  return lines.join('\n')
}
