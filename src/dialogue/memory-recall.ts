import type { AssembledTurn } from './context'
import { mayRecallAcrossSessions } from './audience'
import type { AudienceIdentity, MemoryScope } from './audience'

/**
 * Delivery-memory recall: bring back confirmed turns that aged out of the
 * context window but are relevant to what the listener just said.
 *
 * Why this is separate from ./persona-recall:
 *   - Persona recall serves NORM facts (who she is) from the character bible.
 *   - This port serves EVIDENCE (what was actually said) from confirmed
 *     history. The two data sources stay apart, exactly as delivery memory and
 *     persona facts stay apart everywhere else.
 *
 * Latency and cost constraints (why the candidates arrive pre-fetched):
 *   - Context assembly already loads the full confirmed history for the session
 *     before the turn window is applied, so recall over the dropped remainder
 *     adds NO extra I/O and no model call. The M6 port does not need a search
 *     method for this stage.
 *   - The implementation must stay deterministic (keyword scoring), for the
 *     same reasons as persona recall: zero cost, reproducible for NFR-03,
 *     testable offline. An embedding/LLM scorer could replace it later without
 *     changing the interface.
 *
 * Budget rule: recalled turns are charged to the same `maxCharacters` as
 * persona recall and recent history. Context assembly enforces the cap; a port
 * returning more than fits will have the excess dropped with an exclusion.
 */

/** Maximum recalled turns injected per assembly. */
export const MAX_RECALLED_TURNS = 3

/**
 * Minimum keyword overlap for a candidate to qualify. One shared word is too
 * weak a signal and would surface near-random old turns; two is the cheapest
 * bar that still catches genuine topical callbacks.
 *
 * The bar is a SUM OF TOKEN WEIGHTS, not a count of matches: an informative
 * token (a long Latin word, a number, a CJK bigram of two content characters)
 * is worth two, a thin one is worth one. Two thin tokens - the kind that survive
 * in subtitled, file-less conversation, where the same glue words appear every
 * turn - cannot reach the bar, but one informative token can.
 *
 * A candidate must ALSO share at least one informative token, whatever its
 * total. Score alone would let two different thin tokens (two glue bigrams that
 * happen to align) recall an unrelated old turn, which is the false positive
 * this rule exists to stop.
 */
export const MIN_RECALL_SCORE = 2

/** One recalled turn, with the score that selected it. */
export interface RecalledTurn {
  turn: AssembledTurn
  score: number
}

/**
 * Recall input: the current message and the turns dropped by the turn window.
 *
 * `replyIntent` is carried on the request for a FUTURE intent-aware ranking
 * rule, but it is NOT consumed by the implementation today. Admission is
 * evidence-based and never intent-gated (see ./memory-semantics): an intent can
 * only ever reorder recall among memories already eligible under M4's policies.
 * This invocation passes the field through but does not establish that behavior;
 * a future ranker must state explicit rules and tests (M3 coordination, issue
 * #44 §1). Known limitation, kept explicit rather than silent.
 */
export interface DeliveryRecallRequest {
  inputText: string
  replyIntent: string
  /** Confirmed turns that aged out of the recency window, oldest first. */
  candidates: readonly AssembledTurn[]
  /**
   * The session the recall is being performed FOR.
   *
   * Required because a candidate's own `sessionId` cannot answer the question:
   * without the requesting session there is nothing to compare it against, and a
   * guard that compares two unknowns passes everything.
   */
  sessionId: string
  /**
   * Scope of the requesting turn. Absent means `'session-only'`, the safe
   * direction: a caller that has not thought about scope gets the stricter rule.
   */
  scope?: MemoryScope
  /** Who is listening; absent means anonymous, and therefore never durable. */
  audience?: AudienceIdentity
  /**
   * Sessions explicitly selected by M5's validated archive reconstruction.
   * These sources are authorized by selection, not by an inferred audience.
   */
  explicitlySelectedSessionIds?: readonly string[]
  /**
   * Audience that owns each candidate's memory, read from wherever the caller
   * keeps it (today, nothing does: M6 has no owner column yet).
   *
   * Required for the AUTOMATIC cross-session path: absent or `null` means the
   * source cannot prove the candidate belongs to this listener, and the candidate
   * is refused. An explicitly selected archive does not need it, because M5
   * authorized that session by selection.
   */
  ownerAudienceIdOf?: (turn: AssembledTurn) => string | null
}

/** Delivery-memory recall source. */
export interface DeliveryRecallPort {
  recall(request: DeliveryRecallRequest): readonly RecalledTurn[]
  /**
   * Candidates refused for crossing a session boundary, by the most recent call
   * to `recall`.
   *
   * Read-only and for auditing only. A refused candidate is the kind of loss
   * that would otherwise be invisible: the port did exactly its job, so nothing
   * failed and no warning fired, yet a memory the user might expect is absent.
   * The count lets the caller say so. Exposed as a counter rather than as
   * per-turn detail so the port stays stateless and deterministic.
   *
   * Optional: a port that filters silently is still correct, it just cannot
   * report what it refused. The built-in port always reports.
   */
  readonly crossSessionDrops?: number
}

/**
 * Whether one candidate may be recalled in this request.
 *
 * Same-session candidates are always allowed: that is ordinary recall, and it
 * carries no disclosure risk because the listener is the one who already heard
 * those words.
 *
 * A candidate from ANOTHER session is a different matter, and this is where the
 * guard earns its keep. Such a candidate was produced for some earlier listener,
 * possibly a different person. There are exactly two ways in:
 *
 *   1. **Explicit M5 archive selection.** A session in
 *      `explicitlySelectedSessionIds` was authorized by the validated
 *      reconstruction, so it needs no audience identity at all - M5's producer
 *      deliberately does not invent one. Selection authorizes nothing outside
 *      the validated list.
 *   2. **Automatic audience-based retrieval**, which needs all three of: a
 *      durable current identity (an anonymous or per-session temporary id never
 *      qualifies - M5 ruled the latter does not make memory durable), an
 *      `audience-bound` candidate, and a RECORDED OWNER for that candidate that
 *      matches the current id exactly.
 *
 * Missing owner evidence is a refusal, not a pass. An earlier version treated an
 * absent `ownerAudienceIdOf` as "no mismatch to check" and admitted the
 * candidate, which made the automatic boundary permissive exactly where it
 * matters: the store could not say whose memory it was, so the guard had nothing
 * to compare and chose to trust it. Absence of evidence is not evidence of the
 * same listener. A source that cannot name the owner must route its sessions
 * through explicit selection instead, or wait for M6 to persist an owner per
 * durable record; it must not get a silent pass.
 *
 * The rule is not re-implemented here. `mayRecallAcrossSessions` is the statement
 * of the same conditions for the same question, so this function delegates to it
 * rather than restating them. Two copies of one rule is how the two entry points
 * came to disagree in the first place: `mayRecallAcrossSessions` rejected a
 * missing owner while this path admitted it.
 *
 * The check runs BEFORE scoring, so a cross-session candidate cannot influence
 * the result even when it would be dropped later anyway.
 */
export function mayRecallCandidate(request: DeliveryRecallRequest, turn: AssembledTurn): boolean {
  if (turn.sessionId === request.sessionId) return true
  if (request.explicitlySelectedSessionIds?.includes(turn.sessionId)) return true
  /*
   * The requesting turn's own declared scope is checked, not only the candidate's.
   * `scope` is documented as absent-means-`session-only`, and a caller that has
   * not thought about scope must not get retained memory just because it also
   * happened to pass an identity. Assembly always supplies it, so this changes
   * nothing on the production path; it stops the documented default from being
   * decorative.
   */
  if (request.scope !== 'audience-bound') return false
  return mayRecallAcrossSessions({
    scope: turn.scope,
    ownerAudienceId: request.ownerAudienceIdOf?.(turn),
    currentAudience: request.audience,
  })
}

/*
 * Stopword tables are data, not configuration: they ship with the module and
 * never come from the environment. A word listed here is one that shows up in
 * almost every turn of a subtitled or file-less conversation, so letting it
 * score would make every old turn look "relevant" to every new message and
 * spend the recall budget on noise.
 *
 * Two tables rather than one, because the two tokenizers disagree about what a
 * token is: a Latin token is a whole word, while a CJK token is a bigram. A
 * bigram therefore needs its own "this pair is grammatical glue" table - an
 * English-only list (the previous shape) simply never matched Chinese text.
 */
const LATIN_STOPWORDS = new Set([
  // Articles, conjunctions, prepositions, pronouns.
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'so', 'then', 'than', 'that',
  'this', 'these', 'those', 'there', 'here', 'when', 'where', 'which', 'who',
  'whom', 'whose', 'why', 'how', 'what', 'i', 'you', 'he', 'she', 'it', 'we',
  'they', 'me', 'him', 'her', 'us', 'them', 'my', 'your', 'yours', 'his',
  'its', 'our', 'their', 'mine', 'to', 'of', 'in', 'on', 'at', 'for', 'with',
  'without', 'about', 'into', 'from', 'by', 'as', 'up', 'down', 'out', 'off',
  'over', 'under', 'again',
  // Auxiliaries, modals and copulas.
  'am', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'do', 'does',
  'did', 'done', 'have', 'has', 'had', 'will', 'would', 'shall', 'should',
  'can', 'could', 'may', 'might', 'must',
  // Conversational filler, and the debris of contractions. "maybe"/"perhaps"/
  // "gonna" are 5+ characters, so before they were listed they scored as
  // INFORMATIVE - exactly the false relevance this table exists to prevent.
  'very', 'really', 'just', 'also', 'too', 'not', 'no', 'yes', 'ok', 'okay',
  'yeah', 'oh', 'well', 'now', 'some', 'any', 'all', 'more', 'most', 'much',
  'many', 'don', 'doesn', 'didn', 'isn', 'aren', 'wasn', 'weren', 'can', 'couldn',
  'wouldn', 'shouldn', 'won', 'haven', 'hasn', 'hadn', 'n\'t',
  'maybe', 'perhaps', 'gonna', 'wanna', 'lol', 'lmao',
  // Verbs that report a conversation instead of carrying its topic. "What did
  // you say about X" is a request to RECALL a topic, not a topic itself.
  'say', 'says', 'said', 'tell', 'told', 'talk', 'talks', 'talked', 'ask',
  'asked', 'think', 'thought', 'know', 'knew', 'want', 'wanted', 'get', 'got',
  'go', 'goes', 'went', 'going', 'come', 'came', 'see', 'saw', 'seen', 'look',
  'looked', 'mention', 'mentioned',
])

/**
 * CJK tokens are bigrams, so this table lists the WORD that must not score, in
 * its two-character form. A bigram in this list is skipped outright: it is a
 * closed-class word (pronoun, auxiliary, conjunction) or conversational filler,
 * and it can never establish a topic.
 */
const CJK_STOPWORDS = new Set([
  '我们', '你们', '他们', '她们', '它们', '咱们', '大家', '我的', '你的', '他的',
  '她的', '什么', '怎么', '怎样', '为什么', '多少', '这个', '那个', '哪个', '这些',
  '那些', '这里', '那里', '就是', '可以', '可能', '应该', '没有', '不是', '不会',
  '不要', '不用', '不能', '真的', '觉得', '知道', '时候', '一个', '一下', '一点',
  '有点', '现在', '还是', '因为', '所以', '但是', '然后', '如果', '虽然', '而且',
  '或者', '这样', '那样', '这么', '那么', '东西', '事情', '好的', '好吧', '是的',
  '对的', '嗯嗯', '哈哈', '谢谢', '你好', '再见', '拜拜', '已经', '一直', '还有',
  '告诉', '说的', '说要', '是在', '了吗', '了呢', '了对', '了没', '是吧', '对不对',
  '有没有', '是不是', '好不好', '怎么办', '我记得', '记得', '上次', '刚才', '之前',
  // 感觉/其实 are hedging filler; 自己 is self-reference; 以后 is the mirror of
  // the already-listed 之前. None of the four carries a topic, and because their
  // characters sit outside CJK_FUNCTION_CHARS the bigram tokenizer used to score
  // all of them as informative.
  '感觉', '自己', '其实', '以后',
])

/**
 * CJK characters that are mostly grammatical glue. A bigram containing one of
 * them is still a token - it may be the only thing shared - but it is THIN: it
 * cannot by itself make two turns look related, because it is usually a
 * by-product of word segmentation rather than a word.
 */
const CJK_FUNCTION_CHARS = new Set(
  '的了是我你他她它在有和就不都很吗呢啊吧呀哦这那些什么怎样着过呗嘛啦嗯于把被给让从对与及或但而则也还又再才只'
    .split(''),
)

/**
 * Weight of a token that carries topical information on its own: a long Latin
 * word, a number, or a CJK bigram made of two content characters.
 */
export const INFORMATIVE_TOKEN_WEIGHT = 2
/** Weight of a real-but-common token: a short Latin word or a glue bigram. */
const THIN_TOKEN_WEIGHT = 1

/**
 * Tokenize for overlap scoring, returning each token with the weight it carries.
 *
 * Latin: words of 3+ characters. A word of 5+ characters, or one containing a
 * digit, is informative; a 3-4 character word is thin.
 *
 * CJK: bigrams, because a single character carries almost no topical signal and
 * a whole run would never match across rephrasings. Runs shorter than two
 * characters produce NO token at all - a solitary character such as "我" is a
 * pronoun, and matching it across turns is exactly the extreme false positive
 * this floor exists to prevent. A bigram made of two content characters is
 * informative; one containing a glue character is thin.
 *
 * Exported so the consistency scan (./consistency) uses the same definition of
 * a content token instead of carrying a second, drifting stopword table.
 */
export function contentTokensOf(text: string): ReadonlyMap<string, number> {
  const tokens = new Map<string, number>()
  const lower = text.toLowerCase()
  for (const match of lower.matchAll(/[a-z0-9]+/g)) {
    const word = match[0]
    if (word.length < 3 || LATIN_STOPWORDS.has(word)) continue
    const informative = word.length >= 5 || /\d/.test(word)
    tokens.set(word, informative ? INFORMATIVE_TOKEN_WEIGHT : THIN_TOKEN_WEIGHT)
  }
  for (const match of lower.matchAll(/[一-鿿]+/g)) {
    const run = match[0]
    // Length floor: a one-character run yields no bigram, so it cannot match.
    if (run.length < 2) continue
    for (let index = 0; index + 2 <= run.length; index += 1) {
      const bigram = run.slice(index, index + 2)
      if (CJK_STOPWORDS.has(bigram)) continue
      const glue =
        CJK_FUNCTION_CHARS.has(bigram[0] ?? '') || CJK_FUNCTION_CHARS.has(bigram[1] ?? '')
      tokens.set(bigram, glue ? THIN_TOKEN_WEIGHT : INFORMATIVE_TOKEN_WEIGHT)
    }
  }
  return tokens
}

/**
 * Keyword-overlap recall. Candidates score by the WEIGHT of the content tokens
 * they share with the listener's message; results are ordered by score (ties
 * keep the older turn first, so the budget cap drops the newest of equals rather
 * than the earliest memory).
 *
 * Scoring is deterministic and dictionary-driven (see `contentTokensOf`): zero
 * cost, no I/O, reproducible for NFR-03. It stays coarse by construction - a
 * lexical matcher cannot know that "birthday" and "cake" are related - so it
 * errs toward precision: a candidate has to clear both the weighted score and
 * the informative-token rule.
 *
 * `replyIntent` is carried on the request but not consumed here: it only ever
 * has a ranking role among already-eligible candidates (admission stays
 * evidence-based per ./memory-semantics), and no per-turn semantic tag exists
 * yet to rank on. Intent-aware ranking is follow-up work, not implemented here.
 */
export function createKeywordDeliveryRecall(): DeliveryRecallPort {
  let dropped = 0
  return {
    get crossSessionDrops(): number {
      return dropped
    },
    recall(request) {
      dropped = 0
      const query = contentTokensOf(request.inputText)
      if (query.size === 0) return []
      const scored: RecalledTurn[] = []
      for (const turn of request.candidates) {
        /*
         * Scope guard first. Scoring a forbidden candidate would let a
         * cross-session memory compete for the budget before being discarded,
         * which is a subtler leak than returning it: it changes what ELSE gets
         * recalled. Refusing here keeps the result independent of who is not
         * allowed to be heard.
         */
        if (!mayRecallCandidate(request, turn)) {
          dropped += 1
          continue
        }
        const turnTokens = contentTokensOf(turn.text)
        let score = 0
        let informativeHits = 0
        for (const [token, weight] of query) {
          if (!turnTokens.has(token)) continue
          // A token's weight is a function of its form, so both sides agree.
          score += weight
          if (weight >= INFORMATIVE_TOKEN_WEIGHT) informativeHits += 1
        }
        if (score >= MIN_RECALL_SCORE && informativeHits > 0) scored.push({ turn, score })
      }
      scored.sort((left, right) => right.score - left.score)
      return scored
    },
  }
}
