import { contentTokensOf } from './memory-recall'

/**
 * Deterministic consistency scan over the statements M4 is about to render.
 *
 * Why this exists: NFR-03 character consistency is otherwise guaranteed only
 * indirectly - a persona block plus version trimming. Nothing in the tree
 * compares what the character already confirmed saying against what it says
 * now, or against the standing facts it must always hold. So a turn that says
 * "her birthday is 0603" and an older confirmed turn that says "her birthday is
 * 0704" can both reach the prompt, and the model is free to pick either.
 *
 * What this does: one OFFLINE, deterministic comparison of admitted confirmed
 * statements against each other and against the profile's standing facts. It
 * reports what looks contradictory. It does NOT decide truth, rewrite text,
 * delete a record, change admission, or change the character budget.
 *
 * What this deliberately does not do (issue #44, agreed boundaries):
 *   - no model call, no I/O, no embeddings: NFR-03 A/B attribution depends on
 *     context assembly staying free and reproducible;
 *   - no automatic correction or deletion: a detector that silently rewrote
 *     history would be inventing content, which is exactly what M4 must never
 *     do;
 *   - no admission or budget effect: a flagged statement is still admitted, and
 *     still charged (see `CONFLICT_MARKER` for the opt-in render marker).
 *
 * Scope limits, stated rather than hidden:
 *   - it compares CLAUSES, so a contradiction split across two clauses of one
 *     sentence may be missed;
 *   - it is lexical, so paraphrase ("she is short" vs "she is 151 cm") is not
 *     detected;
 *   - negation is read from a small marker list, so an idiom such as "不错"
 *     ("not bad", i.e. good) is read as negated.
 *
 * The result is AUDIT evidence: ids and counts, never statement text, so it can
 * be handed to the operator console without crossing the redaction boundary of
 * `memory.inspect`.
 */

/** How two statements disagree. */
export type ContradictionKind =
  /** Same content, opposite polarity: "likes coffee" vs "does not like coffee". */
  | 'negation'
  /** Same content, incompatible numbers: "birthday is 0603" vs "birthday is 0704". */
  | 'quantity'
  /** Same object, opposite attribute: "likes cats" vs "hates cats". */
  | 'attribute'

/** One side of a comparison. Ids only; a finding never carries text. */
export type StatementRef =
  | { kind: 'turn'; sessionId: string; turnId: string }
  | { kind: 'persona-fact'; factIndex: number }

/** One statement offered to the scan. */
export interface ConsistencyStatement {
  ref: StatementRef
  text: string
}

export interface ConsistencyScanInput {
  statements: readonly ConsistencyStatement[]
  /** Upper bound on reported findings, so one long history cannot flood audit. */
  maxFindings?: number
}

/**
 * What a finding records. The evidence kind says WHY the pair was compared, so
 * a reviewer can judge the finding without re-deriving the detector's reasoning.
 */
export interface Contradiction {
  kind: ContradictionKind
  left: StatementRef
  right: StatementRef
  /** Which rule fired. */
  evidence: 'polarity' | 'quantity' | 'antonym'
  /**
   * How many content tokens the two clauses shared. A COUNT, not the tokens: the
   * tokens are fragments of memory or persona text, and this payload crosses the
   * redaction boundary described in ./memory-inspect.
   */
  sharedTokenCount: number
}

/** Default cap on findings per scan. */
export const MAX_CONSISTENCY_FINDINGS = 8

/*
 * Negation markers. English is matched as words (with the contraction tail
 * `n't`); Chinese as the markers that actually flip a statement.
 *
 * The Chinese list stops at 不/没/别再/从未 on purpose. A bare 别 would match
 * 别人 ("other people") and 别的 ("other"), and 无 would match 无聊 ("boring"),
 * so both are left out: a detector that fires on those is noise, and noise is
 * how an operator learns to ignore the audit.
 */
const NEGATION_PATTERN = /(?:\bnot\b|\bno\b|\bnever\b|\bcannot\b|\w+n['’]t\b)|不|没|别再|从未|未曾/i
/** Characters removed before tokenizing, so negated and plain clauses align. */
const NEGATION_STRIP_PATTERN = /(?:\bnot\b|\bno\b|\bnever\b|\bcannot\b|\w+n['’]t\b)|[不没]/gi

/**
 * Attribute pairs that mean opposite things about the same object. A closed
 * list, not a thesaurus: only pairs where the disagreement is unambiguous.
 */
const ANTONYM_PAIRS: readonly (readonly [string, string])[] = [
  ['喜欢', '讨厌'],
  ['喜欢', '厌恶'],
  ['爱', '恨'],
  ['同意', '反对'],
  ['like', 'hate'],
  ['love', 'hate'],
  ['agree', 'disagree'],
]

/** Split a statement into clauses; a contradiction lives inside one clause. */
function clausesOf(text: string): readonly string[] {
  return text
    .split(/[。；;!！?？，,、\n]+|(?<=[a-z])\.\s+/i)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0)
}

/** Numbers in a clause, normalized so "0603" and "603" differ but "3:30" holds. */
function numbersOf(text: string): ReadonlySet<string> {
  const numbers = new Set<string>()
  for (const match of text.matchAll(/\d+(?:[.:：/]\d+)*/g)) numbers.add(match[0])
  return numbers
}

interface Claim {
  ref: StatementRef
  /** Content tokens with negation removed, so polarities align for comparison. */
  content: ReadonlySet<string>
  /** Numbers stated in the clause. */
  quantities: ReadonlySet<string>
  /** True when the clause negates its content. */
  negated: boolean
  /** Lowercased clause, used only for the antonym table. */
  lower: string
}

function claimOf(ref: StatementRef, clause: string): Claim | null {
  const content = new Set<string>()
  for (const token of contentTokensOf(clause.replace(NEGATION_STRIP_PATTERN, ' ')).keys()) {
    // Numbers are compared separately: a date is not a topic word.
    if (/^\d+$/.test(token)) continue
    content.add(token)
  }
  if (content.size === 0) return null
  return {
    ref,
    content,
    quantities: numbersOf(clause),
    negated: NEGATION_PATTERN.test(clause),
    lower: clause.toLowerCase(),
  }
}

function sharedCount(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  let shared = 0
  for (const token of left) if (right.has(token)) shared += 1
  return shared
}

/**
 * Whether two clauses are about the same thing.
 *
 * Containment OR overlap, because clause lengths differ for a legitimate reason:
 * a standing fact ("Elleya is 151 cm tall and prefers purple-red...") is a
 * compound sentence, while a turn that contradicts it is usually one short
 * clause. Requiring near-equal token sets would only ever match clauses of the
 * same length, which is why the smaller set being fully contained is enough.
 */
function aboutSameThing(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  const shared = sharedCount(left, right)
  if (shared === 0) return false
  const smaller = Math.min(left.size, right.size)
  return shared === smaller || shared * 2 >= left.size + right.size
}

/**
 * Characters that are never the object of a preference. Used only by the
 * single-character fallback below; the recall tokenizer keeps its stricter
 * two-character floor.
 */
const SINGLE_CHAR_GLUE = new Set('我你他她它们的地得了着过吗呢吧啊是在有和就不'.split(''))

/**
 * Tokens of a clause with the given attribute words removed: the OBJECT that the
 * two clauses disagree about.
 *
 * The bigram tokenizer gives up on a one-character run, which is correct for
 * recall but wrong here: "我喜欢猫" / "我讨厌猫" disagree about 猫, and 猫 is a
 * single character. So a surviving single CJK character that is not glue is
 * kept as its own token, in this comparison only.
 */
function attributeObjectTokens(text: string, words: readonly string[]): Set<string> {
  let rest = text
  for (const word of words) rest = rest.split(word.toLowerCase()).join(' ')
  const tokens = new Set<string>()
  for (const token of contentTokensOf(rest).keys()) {
    if (/^\d+$/.test(token)) continue
    tokens.add(token)
  }
  for (const match of rest.matchAll(/[一-鿿]+/g)) {
    const run = match[0]
    if (run.length !== 1) continue
    if (SINGLE_CHAR_GLUE.has(run)) continue
    tokens.add(run)
  }
  return tokens
}

function refKey(ref: StatementRef): string {
  return ref.kind === 'turn' ? `turn:${ref.sessionId}:${ref.turnId}` : `persona:${ref.factIndex}`
}

/**
 * Scan the supplied statements for contradictions.
 *
 * Order is the caller's order, and the output is stable for a given input, so a
 * review can diff two runs. Comparisons are pairwise over clauses, which is
 * quadratic in the number of clauses - bounded in practice by the handful of
 * turns in a context plus `MAX_STANDING_FACTS`.
 */
export function scanContradictions(input: ConsistencyScanInput): readonly Contradiction[] {
  const maxFindings = input.maxFindings ?? MAX_CONSISTENCY_FINDINGS
  if (maxFindings <= 0) return []

  const claims: Claim[] = []
  for (const statement of input.statements) {
    for (const clause of clausesOf(statement.text)) {
      const claim = claimOf(statement.ref, clause)
      if (claim !== null) claims.push(claim)
    }
  }

  const findings: Contradiction[] = []
  // One finding per pair of statements: the first rule that fired is the most
  // specific description of the disagreement, and repeating the pair would only
  // inflate the warning count.
  const seenPairs = new Set<string>()
  for (let leftIndex = 0; leftIndex < claims.length; leftIndex += 1) {
    const left = claims[leftIndex]
    if (left === undefined) continue
    for (let rightIndex = leftIndex + 1; rightIndex < claims.length; rightIndex += 1) {
      const right = claims[rightIndex]
      if (right === undefined) continue
      if (refKey(left.ref) === refKey(right.ref)) continue
      const pairKey = `${refKey(left.ref)}|${refKey(right.ref)}`
      if (seenPairs.has(pairKey)) continue

      const finding = compareClaims(left, right)
      if (finding === null) continue
      seenPairs.add(pairKey)
      findings.push(finding)
      if (findings.length >= maxFindings) return findings
    }
  }
  return findings
}

/** Compare one ordered pair of clauses; null when they do not disagree. */
function compareClaims(left: Claim, right: Claim): Contradiction | null {
  const shared = sharedCount(left.content, right.content)
  const sameThing = aboutSameThing(left.content, right.content)

  if (sameThing) {
    // Opposite polarity about the same content is the primary case: two records
    // cannot both be right about the same predicate.
    if (left.negated !== right.negated) {
      return {
        kind: 'negation',
        left: left.ref,
        right: right.ref,
        evidence: 'polarity',
        sharedTokenCount: shared,
      }
    }
    // Same polarity, incompatible numbers: two different birthdays for one
    // person are a contradiction whatever the polarity.
    const leftNumbers = [...left.quantities]
    const rightNumbers = [...right.quantities]
    if (
      leftNumbers.length > 0 &&
      rightNumbers.length > 0 &&
      leftNumbers.some((value) => !right.quantities.has(value))
    ) {
      return {
        kind: 'quantity',
        left: left.ref,
        right: right.ref,
        evidence: 'quantity',
        sharedTokenCount: shared,
      }
    }
  }

  return compareAntonyms(left, right)
}

/** Opposite attribute words about the same object: "likes cats" vs "hates cats". */
function compareAntonyms(left: Claim, right: Claim): Contradiction | null {
  for (const [first, second] of ANTONYM_PAIRS) {
    const forward = left.lower.includes(first) && right.lower.includes(second)
    const backward = left.lower.includes(second) && right.lower.includes(first)
    if (!forward && !backward) continue
    const leftRest = attributeObjectTokens(left.lower, [first, second])
    const rightRest = attributeObjectTokens(right.lower, [first, second])
    const shared = sharedCount(leftRest, rightRest)
    // The attribute is opposite, so the OBJECT has to be the same; without a
    // shared object this is two unrelated preferences, not a contradiction.
    if (shared === 0) continue
    return {
      kind: 'attribute',
      left: left.ref,
      right: right.ref,
      evidence: 'antonym',
      sharedTokenCount: shared,
    }
  }
  return null
}
