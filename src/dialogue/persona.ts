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
 *
 * A profile id or a version may contain any character, including whatever
 * delimiter a naive join would use. Concatenating with `@` would let
 * `("a@b", "c")` and `("a", "b@c")` collide into one key, so a record from one
 * persona could be mistaken for another's. The canonical key is therefore the
 * JSON pair, which distinguishes identity from version unambiguously for any
 * inputs and never merges two different personas.
 */
export function personaVersionKey(profileId: string, version: string): string {
  return JSON.stringify([profileId, version])
}

/**
 * A complete, known persona attribution. Returns null when either the identity
 * or the version is missing: a partial pair is not comparable, and treating it
 * as a concrete persona would invent knowledge the evidence does not carry.
 */
export function personaRefFrom(
  profileId: string | null,
  version: string | null,
): { profileId: string; version: string } | null {
  if (profileId === null || version === null) return null
  return { profileId, version }
}

/**
 * Canonical comparison key for a delivery's captured attribution, or null when
 * the delivery carries no complete known persona pair. Durable delivery evidence
 * takes precedence over a process-local note; a partial or absent pair stays
 * unknown rather than being fabricated.
 */
export function personaKeyFromDelivery(delivery: {
  personaProfileId: string | null
  personaProfileVersion: string | null
}): string | null {
  const ref = personaRefFrom(delivery.personaProfileId, delivery.personaProfileVersion)
  return ref === null ? null : personaVersionKey(ref.profileId, ref.version)
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
/**
 * Rule IDs for the bible write guard. Stable strings, because tests assert on
 * them and a reviewer scanning a CI log should be able to look one up here.
 */
export const BIBLE_LEAK_RULES = {
  /** An identifier from a record was pasted into the persona bible. */
  actorId: 'bible-actor-id',
  /** A real listener was described or named inside the persona bible. */
  audienceName: 'bible-audience-name',
  /** Sensitive content from a session leaked into the persona bible. */
  privateContent: 'bible-private-content',
} as const

export type BibleLeakRule = (typeof BIBLE_LEAK_RULES)[keyof typeof BIBLE_LEAK_RULES]

export interface BibleLeakIssue {
  rule: BibleLeakRule
  /** The offending fragment, trimmed for a readable report. */
  excerpt: string
  /** 1-based line number in the bible. */
  line: number
}

/**
 * Identifier assignments that must never appear in the bible.
 *
 * `actorId`/`audienceId`/`listenerId` are record fields. A bible that mentions one
 * by name is holding a piece of a specific person's session record, and because
 * the bible renders EVERY turn, that value would be read out to every later
 * listener. The pattern requires an assignment (`name:` / `name =`), so prose that
 * merely discusses the word "audience" is unaffected.
 */
const BIBLE_ACTOR_ID_PATTERN =
  /\b(?:actor|audience|listener|viewer|viewer|user|session|client)_?id\s*[:=]\s*\S+/gi

/**
 * Literal personal data that must never appear in the bible.
 *
 * These match DATA rather than topics: an address, a phone number. They are
 * checked on every blockquoted line, including lines that carry a negation
 * marker, because the exemption for prohibition prose is about WHAT a sentence
 * names, not about whether a real value is present.
 *
 * Why negation cannot excuse these. A negation marker proves the sentence
 * forbids something; it does not prove the address inside it is invented.
 * "Never write to li.wei@example.com" is still a real mailbox pasted into a file
 * that `renderPersonaBlock` reads out every turn to every listener, and the
 * verb in front of it does not make it less readable. An earlier version
 * returned early for any negated line, so prefixing one word was enough to hide
 * a contact detail from the guard - and the guard then reported a clean bible.
 */
const BIBLE_LITERAL_DATA_PATTERNS: readonly RegExp[] = [
  /[\w.+-]+@[\w-]+\.[\w.]+/, // email address
  /\b(?:\+?\d[\d\s-]{7,}\d)\b/, // long digit run that can be a phone number
]

/**
 * Sensitive TOPICS that are only a problem when asserted as fact.
 *
 * These are matched against asserted text only. See `isNegatedLine`: a boundary
 * such as "Never claim that fictional magic can diagnose" names a sensitive
 * topic in order to forbid it, and that is exactly what a bible SHOULD say. The
 * list stays small and specific: a broad pattern such as "any long digit run"
 * would reject a bible that innocently mentions a year or a stream number, and a
 * guard that cries wolf gets switched off.
 */
const BIBLE_ASSERTED_TOPIC_PATTERNS: readonly RegExp[] = [
  /\b(?:password|passwd|api[_-]?key|secret[_-]?key|credential)s?\b/i,
  // Health and identity data. Present as content, not as a boundary rule.
  /\b(?:diagnosis|diagnosed|medical record|prescription|medication|therapy appointment)\b/i,
  /\b(?:passport|national id|social security|身份证号|病历|诊断书)\b/i,
  // Precise residence.
  /\b(?:lives? at|address(?:es|ed)? is|住址|门牌)\b/i,
]

function pushPrivateIssues(
  issues: BibleLeakIssue[],
  text: string,
  line: number,
  patterns: readonly RegExp[],
): void {
  for (const pattern of patterns) {
    const match = text.match(pattern)
    if (match !== null && match[0] !== undefined) {
      issues.push({ rule: BIBLE_LEAK_RULES.privateContent, excerpt: match[0], line })
    }
  }
}

/**
 * Negative construction markers.
 *
 * A line that forbids something is not disclosing it. "Never pretend to know
 * private facts" is required content, and reporting it would force the author to
 * delete the very boundary the reviewer needs.
 *
 * The exemption covers TOPICS only. It cannot cover literal contact data,
 * because the marker says nothing about whether the value beside it is real:
 * "Never forget to write to li.wei@example.com nightly" forbids nothing at all,
 * yet still carries a mailbox. See `BIBLE_LITERAL_DATA_PATTERNS`.
 */
const NEGATION_MARKERS: readonly string[] = [
  'never',
  'not ',
  'no ',
  'do not',
  "don't",
  'must not',
  'cannot',
  'refuse',
  'forbid',
  '禁止',
  '不得',
  '不要',
  '绝不',
  '不会',
]

function isNegatedLine(line: string): boolean {
  const lower = line.toLowerCase()
  return NEGATION_MARKERS.some((marker) => lower.includes(marker))
}

/**
 * Guard what may be written into the character bible.
 *
 * Division of authority. This is a WRITE-TIME guard on one file, not a runtime
 * filter: it runs in tests over `prompts/dialogue/character.md` and reports
 * problems. It is deliberately independent of audience identity - an anonymous
 * listener is exactly the case that must be protected hardest, and a guard that
 * waited for an identity would be silent for every unlogged viewer.
 *
 * Why the bible specifically. `standingFactsFromBible` promotes `[S]` lines into
 * the runtime prompt, and `renderPersonaBlock` renders the profile EVERY turn to
 * EVERY listener. A record id or a listener's private detail written here is not
 * stored in one place: it is re-read out loud, forever, to whoever connects next.
 * Memories do not have that property - a session memory is scoped to its session,
 * and this file is not.
 *
 * Only blockquoted lines are examined, matching `standingFactsFromBible`: prose
 * in the bible is documentation about the bible and is not itself a persona
 * claim.
 */
export function collectBibleLeakIssues(bible: string): readonly BibleLeakIssue[] {
  const issues: BibleLeakIssue[] = []
  const lines = bible.split(/\r?\n/)

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line === undefined || !/^\s*>/.test(line)) continue
    // Documentation about the format is not a claim. Section 7 explains that
    // `MAX_STANDING_FACT_CHARACTERS` bounds each entry; that sentence mentions
    // neither a person nor a secret, but the marker line would otherwise be
    // scanned as content.
    const text = line.replace(/^\s*>\s*/, '').trim()
    if (text.length === 0) continue
    if (text.startsWith('#') || text.startsWith('`')) continue

    const actorMatch = text.match(BIBLE_ACTOR_ID_PATTERN)
    if (actorMatch !== null && actorMatch[0] !== undefined) {
      issues.push({ rule: BIBLE_LEAK_RULES.actorId, excerpt: actorMatch[0], line: index + 1 })
    }

    // Literal data first, with no exemption: a real address or mailbox is a leak
    // whatever verb stands in front of it.
    pushPrivateIssues(issues, text, index + 1, BIBLE_LITERAL_DATA_PATTERNS)

    // A prohibition names a topic in order to forbid it, so the topic list is
    // checked on asserted text only. The check above already ran, which is what
    // keeps a negation marker from hiding a literal value.
    if (isNegatedLine(text)) continue

    pushPrivateIssues(issues, text, index + 1, BIBLE_ASSERTED_TOPIC_PATTERNS)
  }

  return issues
}

/**
 * Private content that must stay out of the persona bible.
 *
 * The bible is authored, not generated from a session, so the correct home for
 * anything a listener disclosed is that listener's memory - scoped to that
 * audience, never rendered to anyone else. The bible is the one place where
 * scoping cannot help, which is why this list exists.
 */
export const BIBLE_PRIVATE_CONTENT_EXAMPLES: readonly string[] = [
  'A listener\'s real name or handle.',
  'Any identifier copied out of a session record.',
  'A disclosed address, contact detail or credential.',
  'Disclosed health information presented as fact.',
]

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
