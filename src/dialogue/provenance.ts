import type { MemoryScope } from './audience'

/**
 * Provenance: where a rendered line of memory came from.
 *
 * Why this is a type rather than a convention. Both existing renderers already
 * append a trace - `(bible: <factId>)` and `(turn: <session>:<turn>)` - but each
 * one hardcodes its own suffix. That works only while there are exactly two
 * sources. The moment a memory can outlive its session, "which turn was this" is
 * no longer a complete answer: a reviewer reading the prompt needs to know which
 * LISTENER it belongs to as well, or the trace points at a record they cannot
 * look up.
 *
 * The rule: EVERY line that reaches the prompt as memory carries one of these.
 * A memory without provenance may not be rendered at all - an untraceable claim
 * is indistinguishable from an invented one, which is the exact failure NFR-03
 * exists to catch.
 *
 * The rendered suffix stays short and charged to `maxCharacters` like every other
 * character, so this must not grow into a paragraph.
 */
export type Provenance =
  /** An entry in the character bible (`prompts/dialogue/character.md`). */
  | { source: 'bible'; factId: string }
  /** A confirmed turn, addressed by session and turn. */
  | { source: 'session-turn'; sessionId: string; turnId: string }
  /**
   * A long-lived memory bound to one audience, reached from another session.
   *
   * Carries the owner id rather than a display name on purpose: the prompt is a
   * model input and does not need to know who somebody is called, while a
   * reviewer needs to know WHICH record this is. Names live in the record, not in
   * the prompt.
   */
  | { source: 'audience-memory'; audienceId: string; ref: string }

/**
 * Render a provenance suffix, WITHOUT the parentheses.
 *
 * Returns an empty string when the reference is empty, because an empty trace
 * would render as `()` and look like a real reference while being useless. An
 * empty suffix is a loud, visible defect rather than a plausible lie.
 */
export function renderProvenanceSuffix(provenance: Provenance): string {
  switch (provenance.source) {
    case 'bible':
      return provenance.factId.trim().length === 0 ? '' : `bible: ${provenance.factId}`
    case 'session-turn':
      return `turn: ${provenance.sessionId}:${provenance.turnId}`
    case 'audience-memory':
      return `memory: ${provenance.audienceId}/${provenance.ref}`
  }
}

/**
 * The scope label rendered next to a memory whose scope matters to the reader.
 *
 * Only emitted when the memory is `audience-bound`, because marking a
 * session-scoped line as such would spend prompt characters on stating the
 * obvious. A durable memory is the case worth flagging: it is the one that
 * crossed a session boundary, and a reviewer seeing it needs to know that.
 */
export function renderScopeSuffix(scope: MemoryScope): string {
  return scope === 'audience-bound' ? ' [audience-bound]' : ''
}