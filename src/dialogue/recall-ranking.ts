import type { AssembledTurn } from './context'
import type { ListenerTurn } from './listener-history'
import type { AudienceIdentity, MemoryScope } from './audience'
import { scoreSalience } from './salience'
import { contentTokensOf, mayRecallSubject } from './memory-recall'
import type { RecallSubjectShape } from './memory-recall'

/**
 * Multi-factor recall ranking (issue #146 A04).
 *
 * The v1 delivery recall (./memory-recall) answers one question: which old
 * confirmed turns share enough CONTENT WORDS with the current message. It is
 * precision-first, deterministic and cheap, and it stays exactly as it is for
 * every caller that supplies only `deliveryRecall`. This module adds a second,
 * wider ranker for callers that opt in with a `recall` port:
 *
 *   - paraphrases ("what day were you born" against "my birthday is June 3rd"),
 *     pronoun references ("that plan" against an earlier "weekend plan") and
 *     repeated mentions are worth ranking, not only exact word overlap;
 *   - the listener side is a memory too. What the AUDIENCE said earlier ("my
 *     plan for the weekend is to stay home") is exactly what a later pronoun
 *     points at, so listener turns of the current session join the candidate
 *     set;
 *   - importance, recency and prior use are dimensions of their own instead of
 *     tie-breaks.
 *
 * Hard rules (these are issue #146's mandatory constraints, not preferences):
 *   - Deterministic and local. No model call, no provider attempt, no vector
 *     store, no embeddings, no I/O and no clock read: `nowMs` and every
 *     timestamp arrive on the request. The same request always scores the same
 *     way.
 *   - Admission stays evidence-based. A candidate that no lexical dimension ties
 *     to the current message is NOT recalled, however important or fresh it is
 *     (see `MIN_SIMILARITY`). Importance, recency and prior use RANK; they never
 *     admit.
 *   - `replyIntent` is RANKING ONLY. It is applied as a bonus AFTER admission,
 *     so it can reorder admissible items and can never add one: the admissible
 *     set is identical for every intent.
 *   - Cross-session admission is not re-implemented here. Every candidate passes
 *     `mayRecallSubject` (./memory-recall), which defers to the single
 *     `mayRecallCandidate` rule, before it is scored - scoring a forbidden
 *     candidate first would let it compete for the budget even when it is
 *     discarded afterwards. This item is session-only in practice: the
 *     assembler offers no cross-session listener candidate, and listener recall
 *     across sessions waits for X03.
 *
 * Scoring. Every dimension is normalised to 0..1 and combined with the weights
 * issue #146 fixed:
 *
 *   score = 0.35 * similarity   lexically fused evidence (see below)
 *         + 0.25 * importance   A03 decayed salience
 *         + 0.20 * recency      exp(-ageDays / 30)
 *         + 0.10 * topic        topic / entity overlap
 *         + 0.10 * usedBefore   in-session use counter
 *         (+ intent bonus, ranking only)
 *
 * The lexical similarity is the FUSION of three views, and the fusion is part of
 * the score rather than a diagnostic:
 *
 *   1. the Latin content-token view (Jaccard of latin content words);
 *   2. the CJK 3-gram view (cosine over character trigrams);
 *   3. the alias-concept view (`PARAPHRASE_ALIASES`).
 *
 * Views 1 and 2 are first fused by reciprocal rank fusion (k = 60): each view
 * orders the SAME candidate set, so a reciprocal-rank sum is comparable across
 * views and a candidate that is strong in one view is not discarded because the
 * other has nothing to say. The fused value is normalised by its own maximum,
 * which keeps it in 0..1 for any candidate set (with a single candidate it is 1
 * when that candidate is lexically tied to the message at all), and the alias
 * view is then folded in as a paraphrase signal. `scoreParts.rrfLatin`,
 * `scoreParts.rrfCjk` and `scoreParts.lexicalFused` expose the terms for A12.
 *
 * `nowMs` is REQUIRED. Confirmed records carry no delivery timestamp (the same
 * recorded limitation as the transcript pairing note), so a character turn has
 * no age; the only clock this module may use is the one its caller injects,
 * and a listener turn is aged against it. A character turn's recency is the
 * neutral value, never a made-up "just now", and `scoreParts.ageUnknown` says
 * so.
 *
 * `usedBefore` is an in-session memory counter. A `RecallPort` is stateless, so
 * the counter is supplied ON THE REQUEST (`useCounts`) where the caller can see
 * it and a test can pin it. The reply path keeps the counter: `createDialoguePort`
 * owns one per session, passes it on every assembly and increments it for the
 * items that assembly actually rendered, so a memory that was recalled once
 * keeps that rank advantage for the rest of the session. Cross-session
 * "effectively recalled" statistics belong to X02, not to M4.
 */

/** Weights fixed by issue #146 A04. Their sum is 1 before the intent bonus. */
export const RECALL_WEIGHTS = {
  similarity: 0.35,
  importance: 0.25,
  recency: 0.2,
  topic: 0.1,
  usedBefore: 0.1,
} as const

/** Reciprocal-rank-fusion constant used to fuse the Latin and CJK views. */
export const RECALL_RRF_K = 60

/** Recency decay: exp(-ageDays / 30). */
export const RECALL_RECENCY_DAYS = 30

/**
 * Weight of one shared alias concept (see `PARAPHRASE_ALIASES`) in the
 * similarity value: shared concept weight over (query concepts + candidate
 * concepts + this smoothing weight).
 *
 * Literal word overlap and alias overlap are deliberately measured on the same
 * Jaccard scale, so the two can be compared and the stronger one kept:
 *
 *   "tell me about the birthday party" / "The birthday party is on June 3rd"
 *     shares 2 of 3 Latin content words              -> 0.667 literal
 *   "tell me about the birthday party" / "Which birthday?"
 *     shares 1 word and the birthday concept          -> 0.5 literal, 0.5 alias
 *   "what day were you born" / "My birthday is June 3rd"
 *     no shared word, one shared concept              -> 0.25 alias
 *
 * A paraphrase is thus worth strictly less than any real word overlap, which is
 * the order the reply path relies on (`RECALL_ASSEMBLY_MIN_SIMILARITY`).
 */
export const ALIAS_MATCH_WEIGHT = 2

/**
 * Floor on `similarity` for admission, on every recall path.
 *
 * `similarity` is the LARGER of the fused literal value and the alias value
 * (`ALIAS_MATCH_WEIGHT` doc). Only two kinds of evidence can reach it:
 *
 *   - a LITERAL match of real words. One shared word between a two-word message
 *     and a three-word turn is 0.25 and stays out; half the message's words is
 *     0.5 and comes in;
 *   - a PARAPHRASE with topical agreement: the message names ONE concept and
 *     the candidate shares it, which is 0.5 when the words also overlap
 *     ("birthday party" / "Which birthday?") and 0.25 when they do not.
 *
 * The reply path uses the same floor (`RECALL_ASSEMBLY_MIN_SIMILARITY`), so the
 * flagship paraphrase "What day were you born?" against "My birthday is June
 * 3rd" needs one extra admission rule, `RECALL_PARAPHRASE_FLOOR`, rather than a
 * different floor for everything else. The floor is purely lexical:
 * importance, recency, prior use and intent can never reach it.
 */
export const MIN_SIMILARITY = 0.3

/**
 * `similarity` a PARAPHRASE needs when it shares no word with the message at
 * all: the message names exactly one concept and the candidate names the same
 * one.
 *
 * "What day were you born" (birthday, nothing else) against "My birthday is
 * June 3rd" scores 0.25 on the alias value alone. That is deliberately a
 * weaker signal than any literal match - the curated alias pair is the only
 * evidence - so it is admitted by this rule and by nothing else. A message that
 * names several concepts ("the meeting about the novel") or a candidate that
 * merely shares a topic with no concept named by the message never reaches it.
 */
export const RECALL_PARAPHRASE_FLOOR = ALIAS_MATCH_WEIGHT / (1 + 1 + ALIAS_MATCH_WEIGHT)

/**
 * Admission floor the M4 reply path uses (see `RecallRequest.minSimilarity`),
 * identical to `MIN_SIMILARITY`: the reply path asks for no stricter evidence
 * than the ranker's own floor, so a caller can predict what reaches the prompt
 * from the ranker's documented floor alone.
 */
export const RECALL_ASSEMBLY_MIN_SIMILARITY = MIN_SIMILARITY

/** Neutral recency for an item whose age is unknown. */
export const RECALL_NEUTRAL_RECENCY = 0.5

/** Bonuses per `replyIntent` (issue #146 A04). Ranking only; see the header. */
export const RECALL_INTENT_BONUS = {
  support: 0.1,
  clarify: 0.1,
  playful: 0.1,
  answer: 0.05,
  'check-correction': 0.1,
} as const

/**
 * The boundary-neutral memory subject a candidate presents to the cross-session
 * guard.
 *
 * `mayRecallCandidate` (./memory-recall) takes an `AssembledTurn` and reads only
 * its session and retention scope. A listener turn is not an assembled turn, so
 * the guard is handed the smallest record with those two fields and the
 * candidate's role. No assembled turn is fabricated for a listener utterance,
 * and because the guard's verdict depends on nothing else, adapting the shape
 * cannot change it.
 */
export type RecallSubject = RecallSubjectShape

/** A candidate the ranker may consider: a confirmed reply or an audience turn. */
export type RecallCandidate =
  | { role: 'character'; turn: AssembledTurn }
  | { role: 'listener'; turn: ListenerTurn }

/** The weighted dimensions of one score, before the intent bonus. */
export interface RecallScoreParts {
  /** Combined lexical similarity, 0..1 (see the header). */
  similarity: number
  /** A03 decayed salience; a listener turn is scored with `scoreSalience`. */
  importance: number
  /** exp(-ageDays / 30), or `RECALL_NEUTRAL_RECENCY` when no timestamp exists. */
  recency: number
  /** Topic / entity overlap with the current message, 0..1. */
  topic: number
  /** In-session prior-use count mapped into 0..1. */
  usedBefore: number
  /** Ranking-only `replyIntent` bonus. Never part of admission. */
  intentBonus: number
  /** Raw prior-use count the `usedBefore` term came from. */
  useCount: number
  /** Latin reciprocal-rank-fusion contribution. */
  rrfLatin: number
  /** CJK reciprocal-rank-fusion contribution. */
  rrfCjk: number
  /**
   * The Latin/CJK reciprocal-rank-fused lexical value in 0..1, before the alias
   * view is folded in. `similarity` is never below this value.
   */
  lexicalFused: number
  /**
   * Which fusion views carried evidence for this candidate set. `'none'` means
   * no view tied any candidate to the message, so `lexicalFused` is 0 and a
   * candidate can only be admitted on paraphrase evidence.
   */
  fusionViews: 'latin' | 'cjk' | 'latin+cjk' | 'none'
  /**
   * The unchanged v1 keyword score, when the entry came from the v1 keyword
   * adapter (`asRecallPort`). Absent for the multi-factor ranker, whose terms do
   * not reconstruct a v1 score. `similarity` is the v1 score mapped into 0..1,
   * so the two are not interchangeable.
   */
  v1Score?: number
  /** True when the candidate's own age is unknown (a character turn). */
  ageUnknown: boolean
}

/** One recalled candidate with the score that selected it. */
export type RecalledItem = RecallCandidate & {
  score: number
  scoreParts: RecallScoreParts
}

/**
 * Input to one recall ranking.
 *
 * `nowMs` is the recency reference instant in the injected clock's domain.
 * `useCounts` maps `recallItemKey` to the in-session use count. `replyRelevance`
 * lets an M3 decision remove a candidate per-turn, and only that: a value at or
 * below 0 (or not finite) drops the item BEFORE ranking, and any positive value
 * keeps it with an unchanged score, so a callback can never manufacture
 * evidence or distort an order. Scaling a rank would be a second scoring rule
 * owned by the caller, which is not implemented. `conceptAliases` replaces the
 * built-in alias table.
 */
export interface RecallRequest {
  inputText: string
  replyIntent: string
  candidates: readonly RecallCandidate[]
  sessionId: string
  /**
   * Reference instant for recency, in the injected clock's domain. Optional: an
   * assembler with no clock leaves it out and every item keeps the neutral
   * recency rather than a made-up age.
   */
  nowMs?: number
  /** Per-candidate relevance, 1.0 strong / 0.5 moderate / 0 unrelated. */
  replyRelevance?: (candidate: RecallCandidate) => number
  /** Session-local prior-use counts, keyed by `recallItemKey`. */
  useCounts?: Readonly<Record<string, number>>
  /** Alias clusters; replaces `PARAPHRASE_ALIASES` when supplied. */
  conceptAliases?: readonly (readonly string[])[]
  /**
   * Optional admission floor ABOVE `MIN_SIMILARITY` (see
   * `RECALL_ASSEMBLY_MIN_SIMILARITY`). It refines lexical admission only: it
   * cannot admit an item this module would reject, and it never involves
   * importance, recency, prior use or intent.
   */
  minSimilarity?: number
  scope?: MemoryScope
  audience?: AudienceIdentity
  explicitlySelectedSessionIds?: readonly string[]
  /** Recorded owner of a candidate's memory; receives the candidate's subject. */
  ownerAudienceIdOf?: (subject: RecallSubject) => string | null
}

/** Recall source (issue #146 A04). M4-owned and new; it replaces nothing. */
export interface RecallPort {
  recall(request: RecallRequest): readonly RecalledItem[]
  /** Candidates refused by the cross-session rule during the most recent call. */
  readonly crossSessionDrops?: number
}

/* -------------------------------------------------------------------------- */
/* Item identity                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Stable key of one candidate within one session, used for the use counter.
 * The NUL separator keeps the three parts unambiguous, exactly as the
 * utterance and turn keys elsewhere in this module do.
 */
export function recallItemKey(candidate: RecallCandidate): string {
  return candidate.role === 'character'
    ? `character\0${candidate.turn.sessionId}\0${candidate.turn.turnId}`
    : `listener\0${candidate.turn.sessionId}\0${candidate.turn.eventId}`
}

/** The subject one candidate presents to the cross-session guard. */
export function recallSubjectOf(candidate: RecallCandidate): RecallSubject {
  return candidate.role === 'character'
    ? {
        sessionId: candidate.turn.sessionId,
        scope: candidate.turn.scope,
        role: 'character',
        turn: candidate.turn,
      }
    : { sessionId: candidate.turn.sessionId, scope: 'session-only', role: 'listener' }
}

/* -------------------------------------------------------------------------- */
/* Lexical views                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Latin content tokens of the Jaccard view: the words v1 already classifies as
 * content (./memory-recall), restricted to the script this view is for. Reusing
 * v1's tokenizer and stopword table is deliberate: two different notions of a
 * content word in one recall stack is how scores stop being comparable.
 */
export function latinTokensOf(text: string): ReadonlySet<string> {
  const tokens = new Set<string>()
  for (const token of contentTokensOf(text).keys()) {
    if (/^[a-z0-9]+$/.test(token)) tokens.add(token)
  }
  return tokens
}

/**
 * CJK 3-grams for the cosine view. A run shorter than three characters yields
 * nothing: one or two characters are usually a word or glue, and a window of
 * three is the shortest span that can carry a topic. Cosine normalisation keeps
 * a long sentence from outranking a short, specific one merely by containing
 * more windows.
 */
export function cjkTrigramsOf(text: string): ReadonlySet<string> {
  const grams = new Set<string>()
  for (const match of text.matchAll(/[一-鿿]+/g)) {
    const run = match[0]
    for (let index = 0; index + 3 <= run.length; index += 1) {
      grams.add(run.slice(index, index + 3))
    }
  }
  return grams
}

/** Jaccard similarity of two token sets; 0 when either side is empty. */
export function jaccard(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (left.size === 0 || right.size === 0) return 0
  let shared = 0
  for (const token of left) if (right.has(token)) shared += 1
  return shared / (left.size + right.size - shared)
}

/** Cosine similarity of two sets treated as indicator vectors. */
export function cosine(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (left.size === 0 || right.size === 0) return 0
  let shared = 0
  for (const token of left) if (right.has(token)) shared += 1
  return shared / Math.sqrt(left.size * right.size)
}

/**
 * Topic / entity overlap: the share of the query's content tokens that the
 * candidate also carries, averaged with the share of the query's entity tokens
 * (capitalised, non-sentence-initial words) it carries. Entities are weighted
 * next to content words because a name is exactly what a pronoun or a
 * demonstrative points at. 0 when the query carries neither.
 */
export function topicOverlapOf(queryText: string, candidateText: string): number {
  const candidateContent = contentTokensOf(candidateText)
  const candidateLower = candidateText.toLowerCase()

  const content = weightedOverlap(tokensWithWeights(queryText), (token) =>
    candidateContent.has(token) || candidateLower.includes(token),
  )
  const entities = entityTokensOf(queryText)
  const entity = weightedOverlap(
    new Map([...entities].map((token) => [token, 1] as const)),
    (token) => candidateLower.includes(token),
  )
  if (content === null && entity === null) return 0
  if (entity === null) return content ?? 0
  if (content === null) return entity
  return (content + entity) / 2
}

function tokensWithWeights(text: string): ReadonlyMap<string, number> {
  return contentTokensOf(text)
}

function weightedOverlap(
  weights: ReadonlyMap<string, number>,
  hit: (token: string) => boolean,
): number | null {
  let total = 0
  let shared = 0
  for (const [token, weight] of weights) {
    total += weight
    if (hit(token)) shared += weight
  }
  return total === 0 ? null : shared / total
}

/**
 * Capitalised words that are not the first word of the text. Sentence-initial
 * capitalisation is grammar, not a name, so it is not counted.
 */
function entityTokensOf(text: string): ReadonlySet<string> {
  const tokens = new Set<string>()
  const matches = [...text.matchAll(/[A-Za-z][A-Za-z0-9'-]*/g)]
  matches.forEach((match, index) => {
    if (index === 0) return
    if (match[0].length < 2) return
    tokens.add(match[0].toLowerCase())
  })
  return tokens
}

/* -------------------------------------------------------------------------- */
/* Alias concepts                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Concept clusters: words a person may substitute while talking about the SAME
 * thing. Two texts that name the same cluster are treated as paraphrases of
 * that concept.
 *
 * This is a deterministic, curated proxy, nothing more: it covers only what is
 * listed and it never claims semantic understanding. English and Chinese forms
 * sit in one cluster because the conversation may switch language mid-turn.
 * The table is data, not configuration: it ships with the module.
 */
export const PARAPHRASE_ALIASES: readonly (readonly string[])[] = [
  ['birthday', 'born', 'birth', '生日', '出生'],
  ['plan', 'itinerary', 'arrangement', '计划', '安排'],
  ['schedule', 'timetable', 'agenda', '日程', '排期'],
  ['job', 'occupation', '工作', '上班'],
  ['career', '职业'],
  ['favourite', 'favorite', 'prefer', 'preference', '喜欢', '最爱'],
  ['movie', 'film', 'cinema', '电影'],
  ['book', 'novel', 'novella', '小说', '书'],
  ['song', 'music', 'tune', '旋律', '歌'],
  // A related-but-different place is NOT a paraphrase: "town" and "city" are
  // not in one cluster, because "I live in a town" does not answer "which city
  // do you live in". Only the spelling/form variants share a cluster.
  ['hometown', '家乡', '老家'],
  ['beverage', 'drink', '饮料'],
  ['meeting', 'appointment', '会议', '约好'],
  ['travel', 'trip', 'journey', 'voyage', '旅行', '旅游'],
  ['weather', 'forecast', '天气'],
  ['study', 'studies', 'practice', 'practicing', 'learn', 'learning', '学习', '练习'],
]

/*
 * Terms that are deliberately NOT clustered even though they are related, and
 * why. They are listed so a later editor does not "helpfully" add them back:
 *   - sister / brother / sibling, 姐妹 / 哥哥 / 姐姐 / 弟弟 / 妹妹: different
 *     people. Clustering them would answer "is your sister well?" with a memory
 *     about the brother;
 *   - city / town: different kinds of place, and a town is not a smaller city
 *     in anything the reply can rely on;
 *   - job / career / 工作 / 职业: a current post is not a life-long trajectory,
 *     and "what is your job" does not ask where a career took someone;
 *   - workplace: a place, not the work itself;
 *   - schedule: belongs to the schedule cluster only, so every term has exactly
 *     one cluster.
 */

/**
 * A demonstrative or anaphoric reference whose antecedent must be found in an
 * earlier turn: "that plan", "last time", "again", "那个", "刚才", "上次".
 */
const BACK_REFERENCE_PATTERN =
  /(?:^|[^a-z])(?:that|those|previous|earlier|last time|again|the same)(?:[^a-z]|$)|那个|那次|那件|那首|那本|那种|刚才|之前|上次|上次提到|提到过|说过/i

/** Concept profile of one text under one alias table. */
export interface ConceptProfile {
  /** Indices into the alias table this text mentions. */
  concepts: ReadonlySet<number>
  /** True when the text points back at something said earlier. */
  refersBack: boolean
}

function normaliseForAliases(text: string): string {
  return ` ${text
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9一-鿿]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()} `
}

/**
 * True when an alias term is matched on a word boundary. A term that contains
 * Latin letters and digits only is a word; anything carrying a CJK character is
 * matched as a substring, because CJK text is not space-separated.
 */
function isLatinAliasTerm(term: string): boolean {
  return /^[\x20-\x7e]+$/u.test(term)
}

/**
 * Concept profile of one text. Latin terms match on word boundaries so "born"
 * does not fire inside "horn"; CJK terms match as substrings. Each cluster
 * count once, whatever number of its terms appear.
 */
export function conceptProfileOf(
  text: string,
  aliases: readonly (readonly string[])[] = PARAPHRASE_ALIASES,
): ConceptProfile {
  const normalised = normaliseForAliases(text)
  const concepts = new Set<number>()
  aliases.forEach((cluster, index) => {
    for (const term of cluster) {
      const needle = term.toLowerCase().replace(/[’']/g, '')
      if (needle.length === 0) continue
      const hit = isLatinAliasTerm(needle)
        ? normalised.includes(` ${needle} `)
        : normalised.includes(needle)
      if (hit) {
        concepts.add(index)
        return
      }
    }
  })
  return { concepts, refersBack: BACK_REFERENCE_PATTERN.test(text) }
}

/* -------------------------------------------------------------------------- */
/* Dimensions                                                                 */
/* -------------------------------------------------------------------------- */

/** Recency of one item: exp(-ageDays / 30) over the request's reference instant. */
export function recencyOf(occurredAtMs: number | null, nowMs: number | undefined): number {
  if (
    occurredAtMs === null ||
    !Number.isFinite(occurredAtMs) ||
    nowMs === undefined ||
    !Number.isFinite(nowMs)
  ) {
    return RECALL_NEUTRAL_RECENCY
  }
  const ageDays = Math.max(0, nowMs - occurredAtMs) / 86_400_000
  return Math.exp(-ageDays / RECALL_RECENCY_DAYS)
}

/**
 * A03 decayed salience of one candidate.
 *
 * A listener turn has an admission timestamp, so it decays against `nowMs`. A
 * confirmed turn does not (confirmed records carry no delivery timestamp), so
 * its age is unknown and the A03 value the assembler already computed -
 * `salienceScore`, the decayed score at the assembly's anchor - is used as is.
 * Nothing is recomputed here for the character side.
 */
export function importanceOf(
  candidate: RecallCandidate,
  nowMs: number | undefined,
): number {
  if (candidate.role === 'listener') {
    const receivedAtMs = candidate.turn.receivedAtMs
    return scoreSalience({
      role: 'listener',
      text: candidate.turn.text,
      ageMs:
        nowMs !== undefined && Number.isFinite(receivedAtMs)
          ? Math.max(0, nowMs - receivedAtMs)
          : null,
    }).decayed
  }
  return candidate.turn.salienceScore
}

/** The instant a candidate occurred, when its record carries one. */
function occurredAtOf(candidate: RecallCandidate): number | null {
  return candidate.role === 'listener' && Number.isFinite(candidate.turn.receivedAtMs)
    ? candidate.turn.receivedAtMs
    : null
}

/** A turn that names a date, a number or a concrete commitment. */
const CONCRETE_FACT_PATTERN =
  /\d|生日|出生|岁|号|月|日|年|january|february|march|april|may|june|july|august|september|october|november|december|birthday|born|schedule|promise|remember/i

/** A question that was left open: used by the `clarify` bonus only. */
function isOpenQuestion(candidate: RecallCandidate): boolean {
  if (candidate.role !== 'listener') return false
  return /[?？]["'”’)\]】」]?\s*$/.test(candidate.turn.text.trim())
}

/**
 * The `replyIntent` bonus for one candidate.
 *
 * Defined only on the A03 signal vocabulary, so it cannot invent a second
 * notion of "emotional" or "a fact":
 *   - `support`           an emotional peak or a relationship memory;
 *   - `clarify`           a listener turn that is still an open question;
 *   - `playful`           a turn that is both an emotional peak and concrete
 *                         (the shape of a shared joke: a specific thing that
 *                         made people laugh);
 *   - `answer`            a concrete fact - a date, a number, a commitment;
 *   - `check-correction`  a memory the current message re-raises by reference
 *                         ("that plan", "again") and that carries a concrete
 *                         fact.
 * Every other intent, and every candidate that does not match, scores 0.
 */
export function intentBonusOf(
  replyIntent: string,
  candidate: RecallCandidate,
  refersBack: boolean,
): number {
  const signals = scoreSalience({ role: candidate.role, text: candidate.turn.text }).signals
  const has = (signal: (typeof signals)[number]): boolean => signals.includes(signal)
  switch (replyIntent) {
    case 'support':
      return has('emotion-peak') || has('relationship') ? RECALL_INTENT_BONUS.support : 0
    case 'clarify':
      return isOpenQuestion(candidate) ? RECALL_INTENT_BONUS.clarify : 0
    case 'playful':
      return has('emotion-peak') && has('concrete-detail')
        ? RECALL_INTENT_BONUS.playful
        : 0
    case 'answer':
      return has('concrete-detail') || CONCRETE_FACT_PATTERN.test(candidate.turn.text)
        ? RECALL_INTENT_BONUS.answer
        : 0
    case 'check-correction':
      return refersBack && CONCRETE_FACT_PATTERN.test(candidate.turn.text)
        ? RECALL_INTENT_BONUS['check-correction']
        : 0
    default:
      return 0
  }
}

/* -------------------------------------------------------------------------- */
/* The ranker                                                                 */
/* -------------------------------------------------------------------------- */

interface ScoredCandidate {
  candidate: RecallCandidate
  order: number
  similarity: number
  topic: number
  importance: number
  recency: number
  usedBefore: number
  useCount: number
  rrfLatin: number
  rrfCjk: number
  /** Latin/CJK RRF fused into 0..1; folded into `similarity` with the alias view. */
  lexicalFused: number
  /** Alias-cluster evidence in 0..1 (see `ALIAS_MATCH_WEIGHT`). */
  aliasEvidence: number
  intentBonus: number
  ageUnknown: boolean
}

function weightedTotal(entry: ScoredCandidate): number {
  return (
    RECALL_WEIGHTS.similarity * entry.similarity +
    RECALL_WEIGHTS.importance * entry.importance +
    RECALL_WEIGHTS.recency * entry.recency +
    RECALL_WEIGHTS.topic * entry.topic +
    RECALL_WEIGHTS.usedBefore * entry.usedBefore
  )
}

function totalOf(entry: ScoredCandidate): number {
  return weightedTotal(entry) + entry.intentBonus
}

/**
 * Rank positions of the candidates in one view. Equal values share a position
 * (1 + the number of strictly greater values), so reciprocal rank fusion is
 * well defined without inventing a fractional rank. Values arrive in the
 * candidates' own order, so the result cannot depend on sort stability.
 */
function rankPositions(
  entries: readonly ScoredCandidate[],
  values: readonly number[],
): ReadonlyMap<string, number> {
  const ranks = new Map<string, number>()
  entries.forEach((entry, index) => {
    const own = values[index] ?? 0
    let greater = 0
    for (const other of values) if (other > own) greater += 1
    ranks.set(recallItemKey(entry.candidate), greater + 1)
  })
  return ranks
}

function countShared(left: ReadonlySet<number>, right: ReadonlySet<number>): number {
  let shared = 0
  for (const concept of left) if (right.has(concept)) shared += 1
  return shared
}

/**
 * Deterministic multi-factor recall.
 *
 * Ordering: descending score; then an OLDER item before a newer one (the
 * ranker asks for the antecedent, and an older memory is more likely to be
 * the thing a pronoun points back at); then the caller's order, so the result
 * never depends on sort stability alone. A character turn has no timestamp and
 * therefore sorts after an aged listener item with the same score by way of
 * the caller's order only: no age is invented for it.
 */
export function createMultiFactorRecall(): RecallPort {
  let dropped = 0
  return {
    get crossSessionDrops(): number {
      return dropped
    },
    recall(request) {
      dropped = 0
      const aliases = request.conceptAliases ?? PARAPHRASE_ALIASES
      const minSimilarity = request.minSimilarity ?? MIN_SIMILARITY
      const queryLatin = latinTokensOf(request.inputText)
      const queryCjk = cjkTrigramsOf(request.inputText)
      const queryConcepts = conceptProfileOf(request.inputText, aliases)

      const permitted: ScoredCandidate[] = []
      request.candidates.forEach((candidate, order) => {
        // The guard runs BEFORE any scoring (see the header). A character
        // candidate passes its own turn so the rule sees exactly what v1 saw.
        if (!mayRecallSubject(recallSubjectOf(candidate), request)) {
          dropped += 1
          return
        }
        const text = candidate.turn.text
        const occurredAt = occurredAtOf(candidate)
        const useCount = request.useCounts?.[recallItemKey(candidate)] ?? 0
        permitted.push({
          candidate,
          order,
          similarity: 0,
          topic: topicOverlapOf(request.inputText, text),
          importance: importanceOf(candidate, request.nowMs),
          recency: recencyOf(occurredAt, request.nowMs),
          usedBefore:
            Number.isFinite(useCount) && useCount > 0 ? 1 - 1 / (1 + useCount) : 0,
          useCount: Number.isFinite(useCount) && useCount > 0 ? useCount : 0,
          rrfLatin: 0,
          rrfCjk: 0,
          lexicalFused: 0,
          aliasEvidence: 0,
          intentBonus: 0,
          ageUnknown: occurredAt === null,
        })
      })

      /*
       * The lexical evidence of each candidate against the message, computed
       * once and reused by every reader below. It has to be the SAME occurrence
       * everywhere - the fusion ranks, `similarity`, admission and the rendered
       * `scoreParts` - or the score explains a different measurement from the
       * one that admitted the item.
       */
      const latinValues = permitted.map((entry) =>
        jaccard(queryLatin, latinTokensOf(entry.candidate.turn.text)),
      )
      const cjkValues = permitted.map((entry) =>
        cosine(queryCjk, cjkTrigramsOf(entry.candidate.turn.text)),
      )
      const candidateConceptsOf = permitted.map(
        (entry) => conceptProfileOf(entry.candidate.turn.text, aliases).concepts,
      )
      const latinRanks = rankPositions(permitted, latinValues)
      const cjkRanks = rankPositions(permitted, cjkValues)
      const floor = Math.max(MIN_SIMILARITY, minSimilarity)

      /*
       * Reciprocal-rank fusion (k = RECALL_RRF_K) of the lexical views.
       *
       * Each view ranks the SAME candidate set by its own similarity, so the
       * credits are comparable across views and a candidate strong in one view
       * is not hidden by a view that says little about it.
       *
       * What a view contributes, and what it does not:
       *
       *   - a view that ORDERS the set gives every candidate its reciprocal-rank
       *     credit, exactly as a rank-based score does;
       *   - a view that cannot order the set - ABSENT (the message carries no
       *     token of that script) or TIED (no candidate ties the message in it,
       *     so `rankPositions` would hand everyone rank 1) - orders nothing and
       *     gives no credit. A shared rank is not evidence.
       *
       * The credits are summed and normalised by the best sum the set reaches,
       * which puts the leading candidate at 1 and keeps the value in 0..1. The
       * normalised value is `lexicalFused`; it is NOT `similarity` on its own,
       * because a share of the best rank would call a candidate with one weak
       * shared word the equal of one that repeats half the message. The rank
       * credit therefore scales that candidate's own word overlap below (see
       * the `entry.similarity` comment), and a candidate that ties the message
       * in no view keeps 0 however few candidates there are.
       */
      const rrfLatinValues: number[] = []
      const rrfCjkValues: number[] = []
      permitted.forEach((entry) => {
        const key = recallItemKey(entry.candidate)
        const latin = 1 / (RECALL_RRF_K + (latinRanks.get(key) ?? 1))
        const cjk = 1 / (RECALL_RRF_K + (cjkRanks.get(key) ?? 1))
        entry.rrfLatin = latin
        entry.rrfCjk = cjk
        rrfLatinValues.push(latin)
        rrfCjkValues.push(cjk)
      })
      const presentLatin = queryLatin.size > 0
      const presentCjk = queryCjk.size > 0
      const latinOrders = presentLatin && latinValues.some((value) => value > 0)
      const cjkOrders = presentCjk && cjkValues.some((value) => value > 0)
      const fusedSums = permitted.map(
        (_entry, index) =>
          (latinOrders ? (rrfLatinValues[index] ?? 0) : 0) +
          (cjkOrders ? (rrfCjkValues[index] ?? 0) : 0),
      )
      const bestFused = Math.max(0, ...fusedSums)
      /*
       * The credit of the best-ranked candidate, which sets the top of the 0..1
       * boost below. It is the same denominator for every candidate, so a
       * candidate's boost reflects how far it is behind the best one, not how
       * many candidates happen to be in the set.
       */
      const fusionViews =
        latinOrders && cjkOrders
          ? 'latin+cjk'
          : latinOrders
            ? 'latin'
            : cjkOrders
              ? 'cjk'
              : 'none'
      /*
       * Alias clusters the message names alongside something else. A message
       * that only names one concept is asking ABOUT that concept ("what day were
       * you born" names birthday and nothing else), so an earlier turn about it
       * is the antecedent. A message that lists several ("the meeting about the
       * novel") is asking about a combination, and a single shared concept is
       * not evidence of it.
       */
      const queryNamesSingleConcept = queryConcepts.concepts.size === 1

      const admitted: ScoredCandidate[] = []
      permitted.forEach((entry, index) => {
        const candidateConcepts = candidateConceptsOf[index] ?? new Set<number>()
        const sharedConcepts = countShared(queryConcepts.concepts, candidateConcepts)
        /*
         * Alias evidence is the Jaccard share of concepts plus the smoothing
         * weight. Two DIFFERENT concepts on the two sides ("the meeting about
         * the novel" / "my novel is coming out") are a combination, not a
         * paraphrase, so agreeing on one of them is not paraphrase evidence:
         * only a candidate whose concepts are a SUPERSET of the message's is
         * paraphrasing it.
         */
        const aliasValue =
          sharedConcepts === 0
            ? 0
            : (sharedConcepts * ALIAS_MATCH_WEIGHT) /
              (queryConcepts.concepts.size +
                candidateConcepts.size +
                ALIAS_MATCH_WEIGHT)
        const coversQuery =
          queryConcepts.concepts.size > 0 && sharedConcepts === queryConcepts.concepts.size
        const literal = Math.max(latinValues[index] ?? 0, cjkValues[index] ?? 0)
        const fused =
          bestFused > 0 && literal > 0
            ? Math.min(1, (fusedSums[index] ?? 0) / bestFused)
            : 0
        /*
         * The fused rank credit BOOSTS the candidate's own word overlap and
         * NEVER replaces it: this term is `overlap * (1 + fused)`, capped at 1,
         * where `fused` is the candidate's share of the best rank sum. A
         * candidate can therefore never score above what its words support by
         * more than a factor of two, one weak shared word can never reach a
         * candidate that repeats half the message, and a candidate tied to the
         * message in no view has `fused = 0` and keeps only its overlap.
         *
         * A tie in the fusion is therefore not a scoring tie: two candidates
         * that share the top rank are still ordered by the item-level terms
         * (importance, recency, prior use) and the intent bonus, which is what
         * those dimensions exist for.
         */
        const literalSimilarity = Math.min(1, literal * (1 + fused))
        entry.aliasEvidence = aliasValue
        entry.lexicalFused = fused
        /*
         * `similarity` is the larger of the fused literal value and the alias
         * evidence, kept in 0..1, so it is still one comparable lexical number.
         * Alias evidence can only raise a candidate whose words say little
         * (the flagship paraphrase scores 0.5 on the alias pair alone); it can
         * never exceed 1, and a candidate with no literal or alias tie stays 0.
         */
        entry.similarity = Math.min(1, Math.max(literalSimilarity, aliasValue))
        entry.intentBonus = intentBonusOf(
          request.replyIntent,
          entry.candidate,
          queryConcepts.refersBack,
        )
        /*
         * The PARAPHRASE signal, as opposed to merely naming the same topic: the
         * message names one concept and nothing else, and the candidate names
         * the same one. "What day were you born" asks about the birthday; "the
         * meeting about the novel" asks about a combination, and a single
         * shared concept is not evidence of it.
         */
        const paraphrase = queryNamesSingleConcept && coversQuery
        const resolved = entry.similarity
        /*
         * Admission: lexical evidence only.
         *
         *   - a PARAPHRASE (the message names exactly one concept and the
         *     candidate names it) is measured against
         *     `RECALL_PARAPHRASE_FLOOR`, the value the curated alias pair alone
         *     earns. It shares no word with the message, so the literal floor
         *     cannot say anything about it;
         *   - anything else is measured against `MIN_SIMILARITY` (or a stricter
         *     caller value), which a shared topic word alone never reaches.
         *
         * A caller may RAISE the floor but never lower it, and ranking terms
         * never enter this test.
         */
        if (!paraphrase && resolved < floor) return
        /*
         * A paraphrase shares no word with the message, so the floor above
         * measures nothing it has; `RECALL_PARAPHRASE_FLOOR` is its bar, and it
         * is a FLOOR, so a caller asking for stricter evidence is still obeyed.
         */
        if (paraphrase && resolved < RECALL_PARAPHRASE_FLOOR)
          return
        /*
         * A caller-declared irrelevance removes an item BEFORE ranking - it
         * never adds one - so an M3 "not relevant" verdict can suppress a
         * candidate without raising its score.
         */
        const relevance = request.replyRelevance?.(entry.candidate)
        if (relevance !== undefined && (!Number.isFinite(relevance) || relevance <= 0)) return
        admitted.push(entry)
      })

      admitted.sort((left, right) => {
        const byScore = totalOf(right) - totalOf(left)
        if (byScore !== 0) return byScore
        const leftAt = occurredAtOf(left.candidate)
        const rightAt = occurredAtOf(right.candidate)
        if (leftAt !== null && rightAt !== null && leftAt !== rightAt) return leftAt - rightAt
        return left.order - right.order
      })

      return admitted.map((entry): RecalledItem => {
        const scoreParts: RecallScoreParts = {
          similarity: entry.similarity,
          importance: entry.importance,
          recency: entry.recency,
          topic: entry.topic,
          usedBefore: entry.usedBefore,
          intentBonus: entry.intentBonus,
          useCount: entry.useCount,
          rrfLatin: entry.rrfLatin,
          rrfCjk: entry.rrfCjk,
          lexicalFused: entry.lexicalFused,
          fusionViews,
          ageUnknown: entry.ageUnknown,
        }
        const score = totalOf(entry)
        return entry.candidate.role === 'character'
          ? { role: 'character', turn: entry.candidate.turn, score, scoreParts }
          : { role: 'listener', turn: entry.candidate.turn, score, scoreParts }
      })
    },
  }
}
