import { describe, expect, it } from 'vitest'
import { REPLY_INTENTS } from '../../src/contracts'
import {
  AUTHOR_CHARACTER_PROFILE,
  createDeliveryMemoryStore,
  createDialoguePort,
  DEFAULT_CHARACTER_PROFILES,
  FIXTURE_CHARACTER_PROFILE,
  renderDialoguePrompt,
} from '../../src/dialogue'
import type {
  AssembledDialogueContext,
  AssembledTurn,
  DeliveryMemoryStore,
  DialogueTextSource,
} from '../../src/dialogue'
import type { DialogueRequest } from '../../src/contracts'
import {
  anchorScore,
  MAX_STYLE_ANCHORS,
  normalizeAnchorText,
  renderStyleAnchorLines,
  selectStyleAnchors,
  STYLE_ANCHOR_MAX_CHARS,
  STYLE_ANCHOR_MIN_CHARS,
  STYLE_ANCHORS_ENABLED,
  STYLE_ANCHORS_HEADER,
} from '../../src/dialogue/style-anchors'
import { DEFAULT_STYLE_CONTRACT, deriveStyleContract } from '../../src/dialogue/style-contract'
import type { StyleContract } from '../../src/dialogue/style-contract'
import { createCallContext } from '../support/context'
import { FIXTURE_SESSION_ID, fixtureCommitDelivery, fixtureDialogueRequest } from '../support/fixture-data'

/**
 * Style anchors (issue #146 A11, part 1).
 *
 * Two layers are tested: `selectStyleAnchors` as a pure function over
 * assembled turns, and the assembled prompt, which must place the section right
 * after the persona block, charge only the entry lines, and leave the off path
 * byte-identical.
 */

const PROFILE = AUTHOR_CHARACTER_PROFILE
const CONTRACT = deriveStyleContract(PROFILE)
const SESSION = FIXTURE_SESSION_ID
/**
 * `DEFAULT_STYLE_CONTRACT` with the two profile fields the selector needs.
 * Selection never renders a boundary fallback, so they are left empty per
 * intent - the same shape the function's own default uses.
 */
const DEFAULT_STYLE_CONTRACT_FOR_TEST: StyleContract = {
  ...DEFAULT_STYLE_CONTRACT,
  profileId: PROFILE.profileId,
  boundaryFallbacks: {
    support: [],
    answer: [],
    clarify: [],
    acknowledge: [],
    playful: [],
    'check-correction': [],
  },
}
const VERSION_KEY = JSON.stringify([PROFILE.profileId, PROFILE.version])
const OTHER_VERSION_KEY = JSON.stringify([PROFILE.profileId, '0'])

/**
 * One assembled turn. Only the fields the selector reads are significant; the
 * rest are filled with the values a real assembly produces so the fixture is
 * not accidentally shaped differently from production.
 */
function turn(
  turnId: string,
  text: string,
  overrides: Partial<AssembledTurn> = {},
): AssembledTurn {
  const base: AssembledTurn = {
    sessionId: SESSION,
    turnId,
    segments: [],
    text,
    interrupted: false,
    personaVersion: VERSION_KEY,
    pinned: false,
    salienceScore: 0.3,
    salienceSignals: [],
    scope: 'session-only',
    kind: 'utterance',
    characters: text.length,
  }
  return { ...base, ...overrides }
}

/** A line with a tic (matches the contract's hmph|nya pattern). */
const TIC_LINE = 'Hmph, you were up late again, human.'
/** A line with a form of address but no tic. */
const ADDRESS_LINE = 'You should sit down before the stream starts.'
/** A line with an emotional salience signal. */
const EMOTION_LINE = 'Do not misunderstand, I only stay because it is quiet.'

function withEmotion(line: AssembledTurn): AssembledTurn {
  return { ...line, salienceSignals: ['emotion-peak'] }
}

function idsOf(anchors: readonly AssembledTurn[]): readonly string[] {
  return anchors.map((anchor) => anchor.turnId)
}

describe('M4 style anchors — selection filters', () => {
  it('excludes a turn from a stale or unknown persona version', () => {
    const selection = selectStyleAnchors(
      [
        turn('current', TIC_LINE),
        turn('stale', 'This line was said by an older version of her.', { personaVersion: OTHER_VERSION_KEY }),
        turn('unknown', 'This line carries no persona attribution.', { personaVersion: null }),
      ],
      VERSION_KEY,
      MAX_STYLE_ANCHORS,
    )
    expect(idsOf(selection.anchors)).toEqual(['current'])
    expect(selection.exclusions).toEqual([
      expect.objectContaining({ turnId: 'stale', reason: 'stale-persona' }),
      expect.objectContaining({ turnId: 'unknown', reason: 'stale-persona' }),
    ])
  })

  it('excludes lines outside 20..80 characters, on the trimmed text', () => {
    const short = 'Hmph.' // 5 characters
    const fits = 'Hmph, this line fits the window exactly.' // 41 characters
    const long = `Hmph, ${'and '.repeat(30)}so it runs on and on.` // > 80
    const padded = `   ${fits}   `
    const selection = selectStyleAnchors(
      [
        turn('short', short),
        turn('fits', fits),
        turn('long', long),
        turn('padded', padded),
        // Padding must not rescue a short line either.
        turn('padded-short', `   ${short}   `),
      ],
      VERSION_KEY,
      MAX_STYLE_ANCHORS,
    )
    expect(selection.exclusions.find((entry) => entry.turnId === 'short')?.reason).toBe('too-short')
    expect(
      selection.exclusions.find((entry) => entry.turnId === 'padded-short')?.reason,
    ).toBe('too-short')
    expect(selection.exclusions.find((entry) => entry.turnId === 'long')?.reason).toBe('too-long')
    // `padded` normalizes to `fits`, so it is the same line: one is kept as a
    // duplicate rather than both being shown.
    expect(selection.exclusions.find((entry) => entry.turnId === 'padded')?.reason).toBe(
      'duplicate',
    )
    expect(idsOf(selection.anchors)).toEqual(['fits'])
    expect(STYLE_ANCHOR_MIN_CHARS).toBe(20)
    expect(STYLE_ANCHOR_MAX_CHARS).toBe(80)
  })

  it('excludes interrupted and conflicting turns', () => {
    const selection = selectStyleAnchors(
      [
        turn('interrupted', 'Hmph, I was going to say some', { interrupted: true }),
        turn('conflicting', 'Hmph, I am 172 cm tall, apparently.', { conflicting: true }),
        turn('clean', TIC_LINE),
      ],
      VERSION_KEY,
      MAX_STYLE_ANCHORS,
    )
    expect(idsOf(selection.anchors)).toEqual(['clean'])
    expect(selection.exclusions).toEqual([
      expect.objectContaining({ turnId: 'interrupted', reason: 'interrupted' }),
      expect.objectContaining({ turnId: 'conflicting', reason: 'conflicting' }),
    ])
  })

  it('excludes empty and whitespace-only turns, and keeps one copy of a duplicate', () => {
    const selection = selectStyleAnchors(
      [
        turn('empty', ''),
        turn('spaces', '   \t  '),
        turn('first', TIC_LINE),
        // Same text modulo whitespace: one normalized line, not two.
        turn('second', `  ${TIC_LINE.replace(' ', '   ')}  `),
      ],
      VERSION_KEY,
      MAX_STYLE_ANCHORS,
    )
    expect(idsOf(selection.anchors)).toEqual(['first'])
    expect(selection.exclusions).toEqual([
      expect.objectContaining({ turnId: 'empty', reason: 'empty' }),
      expect.objectContaining({ turnId: 'spaces', reason: 'empty' }),
      expect.objectContaining({ turnId: 'second', reason: 'duplicate' }),
    ])
  })

  it('keeps at most `limit` anchors and reports the rest as `limit`', () => {
    const turns = Array.from({ length: 6 }, (_unused, index) =>
      turn(`t${index}`, `A neutral line number ${index} said in passing.`),
    )
    const selection = selectStyleAnchors(turns, VERSION_KEY)
    expect(selection.anchors).toHaveLength(MAX_STYLE_ANCHORS)
    expect(MAX_STYLE_ANCHORS).toBe(3)
    expect(selection.exclusions.filter((entry) => entry.reason === 'limit')).toHaveLength(3)

    const two = selectStyleAnchors(turns, VERSION_KEY, 2)
    expect(two.anchors).toHaveLength(2)
    const none = selectStyleAnchors(turns, VERSION_KEY, 0)
    expect(none.anchors).toEqual([])
    expect(none.exclusions.every((entry) => entry.reason === 'limit')).toBe(true)
  })

  it('prefers a tic, a form of address, then an emotional turn, ties keeping input order', () => {
    // All four lines pass the filters; only the markers differ.
    const neutral = turn('neutral', 'The quiet minutes of the stream went by.')
    const emotional = withEmotion(turn('emotional', 'The room was cold, and I said nothing.'))
    const address = turn('address', ADDRESS_LINE)
    const tic = turn('tic', TIC_LINE)
    const selection = selectStyleAnchors(
      [neutral, emotional, address, tic],
      VERSION_KEY,
      MAX_STYLE_ANCHORS,
      CONTRACT,
    )
    // The tic line also says "human", a form of address, so it scores 2 and
    // outranks the other three, which tie at 1 and keep input order among
    // themselves. `neutral` (score 0) never enters the top three.
    expect(idsOf(selection.anchors)).toEqual(['tic', 'emotional', 'address'])
    expect(selection.exclusions).toEqual([
      expect.objectContaining({ turnId: 'neutral', reason: 'limit' }),
    ])

    // A line with two markers outranks a line with one.
    const both = turn('both', 'Hmph, sit down, human, the stream is over.')
    const ranked = selectStyleAnchors([address, both], VERSION_KEY, 1, CONTRACT)
    expect(idsOf(ranked.anchors)).toEqual(['both'])
  })

  it('is deterministic: the same input in the same order gives the same output', () => {
    const turns = [
      turn('a', TIC_LINE),
      turn('b', ADDRESS_LINE),
      withEmotion(turn('c', EMOTION_LINE)),
      turn('d', 'The quiet minutes of the stream went by.'),
    ]
    const first = selectStyleAnchors(turns, VERSION_KEY, MAX_STYLE_ANCHORS, CONTRACT)
    const second = selectStyleAnchors(turns, VERSION_KEY, MAX_STYLE_ANCHORS, CONTRACT)
    expect(second).toEqual(first)
    // Selection does not depend on when it runs or on a clock, but it does
    // depend on input order: reversing the history reverses the tie order.
    const shuffled = selectStyleAnchors([...turns].reverse(), VERSION_KEY, MAX_STYLE_ANCHORS, CONTRACT)
    expect(idsOf(shuffled.anchors)).toEqual(['a', 'c', 'b'])
  })

  it('normalizes the rendered text to one line and never carries a newline', () => {
    const selection = selectStyleAnchors(
      [turn('multiline', 'Hmph, this line was\nbroken across   two lines.')],
      VERSION_KEY,
    )
    const lines = renderStyleAnchorLines(selection.anchors)
    expect(lines).toEqual(['- Hmph, this line was broken across two lines.'])
    for (const line of lines) expect(line).not.toContain('\n')
    expect(normalizeAnchorText(' a\n\tb ')).toBe('a b')
  })

  it('omitting the contract uses the shipped defaults, so voice markers still count', () => {
    /*
     * The default must come from DEFAULT_STYLE_CONTRACT, not an empty stub. An
     * empty stub left the tic and the address list empty, so the two strongest
     * markers scored zero forever and selection silently degraded to input
     * order. Here the marker-free ordering is the same with and without the
     * argument, and a marker line beats a neutral one either way.
     */
    const neutral = turn('neutral', 'The quiet minutes of the stream went by.')
    const address = turn('address', ADDRESS_LINE)
    const tic = turn('tic', 'Hmph, you were up late again.')

    const implicit = selectStyleAnchors([neutral, address, tic], VERSION_KEY, MAX_STYLE_ANCHORS)
    const explicit = selectStyleAnchors(
      [neutral, address, tic],
      VERSION_KEY,
      MAX_STYLE_ANCHORS,
      DEFAULT_STYLE_CONTRACT_FOR_TEST,
    )
    expect(idsOf(implicit.anchors)).toEqual(idsOf(explicit.anchors))
    // Both marker lines outrank the neutral one. The tic line also says
    // "you", so it scores 2 against the address line's 1.
    expect(idsOf(implicit.anchors)).toEqual(['tic', 'address', 'neutral'])

    // And one marker line alone beats a neutral line when only one slot exists.
    const oneSlot = selectStyleAnchors([neutral, tic], VERSION_KEY, 1)
    expect(idsOf(oneSlot.anchors)).toEqual(['tic'])

    // The default is not the old empty stub: its tic and address vocabulary are
    // the shipped table's.
    expect(anchorScore(neutral, DEFAULT_STYLE_CONTRACT_FOR_TEST)).toBe(0)
    expect(anchorScore(address, DEFAULT_STYLE_CONTRACT_FOR_TEST)).toBe(1)
    expect(anchorScore(tic, DEFAULT_STYLE_CONTRACT_FOR_TEST)).toBe(2)
  })

  it('accepts a contract with no tic and no address list without matching anything', () => {
    const bare: StyleContract = {
      ...CONTRACT,
      tic: null,
      audienceAddress: [],
    }
    const selection = selectStyleAnchors([turn('a', TIC_LINE), turn('b', ADDRESS_LINE)], VERSION_KEY, 1, bare)
    // With no markers every candidate scores 0, so input order decides.
    expect(idsOf(selection.anchors)).toEqual(['a'])
  })

  it('excludes a line that restates a standing fact, and keeps a line that does not', () => {
    /*
     * A11: the anchor section is a voice reference, not a second place to state
     * what the persona block already states. An anchor whose normalized,
     * lower-cased text is a substring of a standing fact (or vice versa) is
     * excluded with its own reason, AFTER the length checks and BEFORE the
     * duplicate filter.
     */
    const fact =
      'She was born on June 3rd in the northern harbour town and still keeps a map of it'
    // 20..80 characters, and a substring of the fact above.
    const repeated = turn('repeated', 'born on June 3rd in the northern harbour town')
    expect(normalizeAnchorText(repeated.text).length).toBeGreaterThanOrEqual(STYLE_ANCHOR_MIN_CHARS)
    expect(normalizeAnchorText(repeated.text).length).toBeLessThanOrEqual(STYLE_ANCHOR_MAX_CHARS)
    expect(fact.toLowerCase()).toContain(normalizeAnchorText(repeated.text).toLowerCase())

    const unique = turn('unique', TIC_LINE)
    const selection = selectStyleAnchors(
      [repeated, unique],
      VERSION_KEY,
      MAX_STYLE_ANCHORS,
      CONTRACT,
      [fact],
    )
    expect(idsOf(selection.anchors)).toEqual(['unique'])
    expect(selection.exclusions).toEqual([
      expect.objectContaining({ turnId: 'repeated', reason: 'standing-fact' }),
    ])

    // The negative control: without the fact the same line IS an anchor, so the
    // exclusion above is the fact filter and not another reason.
    const withoutFacts = selectStyleAnchors([repeated, unique], VERSION_KEY, MAX_STYLE_ANCHORS, CONTRACT)
    expect(idsOf(withoutFacts.anchors)).toContain('repeated')

    // Case and spacing do not matter, and a fact SHORTER than the anchor (the
    // anchor contains the fact) is excluded too.
    const containing = turn('containing', 'Hmph, the harbour town map is on the shelf, human.')
    const shortFact = selectStyleAnchors(
      [containing],
      VERSION_KEY,
      MAX_STYLE_ANCHORS,
      CONTRACT,
      ['  The Harbour   Town map  '],
    )
    expect(idsOf(shortFact.anchors)).toEqual([])
    expect(shortFact.exclusions).toEqual([
      expect.objectContaining({ turnId: 'containing', reason: 'standing-fact' }),
    ])

    // An empty fact is skipped: it is a substring of every line, so treating it
    // as a needle would exclude the whole section.
    const blankFact = selectStyleAnchors([unique], VERSION_KEY, MAX_STYLE_ANCHORS, CONTRACT, ['   '])
    expect(idsOf(blankFact.anchors)).toEqual(['unique'])
  })
})

/* -------------------------------------------------------------------------- */
/* Assembly                                                                   */
/* -------------------------------------------------------------------------- */

const PROFILE_FOR_ASSEMBLY = DEFAULT_CHARACTER_PROFILES[1]!

/** Commit one delivered turn with the authored persona attribution. */
async function commit(
  memory: DeliveryMemoryStore,
  turnId: string,
  text: string,
  personaVersion: string = PROFILE_FOR_ASSEMBLY.version,
): Promise<void> {
  await memory.commit(
    fixtureCommitDelivery({
      sessionId: SESSION,
      turnId,
      segmentId: `${turnId}-seg-0`,
      textHash: `hash-${turnId}`,
      text: text,
      personaProfileId: PROFILE_FOR_ASSEMBLY.profileId,
      personaProfileVersion: personaVersion,
    }),
  )
}

async function memoryWith(
  texts: readonly string[],
  options: { personaVersion?: string } = {},
): Promise<DeliveryMemoryStore> {
  const memory = createDeliveryMemoryStore()
  for (const [index, text] of texts.entries()) {
    await commit(memory, `turn-${index + 1}`, text, options.personaVersion)
  }
  return memory
}

function capturingSource(capture: { view: AssembledDialogueContext | null }): DialogueTextSource {
  return {
    model: 'test-source',
    modelVersion: 'test-v1',
    resolvedModel: null,
    async compose(view) {
      capture.view = view
      return ['Captured reply.']
    },
  }
}

/** The authored-character request with a fixed budget. */
function authoredRequest(options: { maxTurns?: number; maxCharacters?: number } = {}): DialogueRequest {
  return fixtureDialogueRequest({
    characterProfileId: PROFILE_FOR_ASSEMBLY.profileId,
    characterProfileVersion: PROFILE_FOR_ASSEMBLY.version,
    selectedInput: { eventId: 'none', text: 'Good evening.' },
    contextLimits: {
      maxTurns: options.maxTurns ?? 8,
      maxCharacters: options.maxCharacters ?? 2_000,
    },
  })
}

async function assemble(options: {
  memory: DeliveryMemoryStore
  styleAnchors: boolean
  request?: DialogueRequest
}): Promise<AssembledDialogueContext> {
  const capture: { view: AssembledDialogueContext | null } = { view: null }
  const port = createDialoguePort({
    clock: { nowMs: () => 1_000 },
    history: options.memory,
    textSource: capturingSource(capture),
    styleAnchors: options.styleAnchors,
  })
  await port.generate(options.request ?? authoredRequest(), createCallContext(), {
    segment: async () => {},
  })
  if (capture.view === null) throw new Error('context was not assembled')
  return capture.view
}

describe('M4 style anchors — assembly and rendering', () => {
  it('renders the header after the persona block and before the state block', async () => {
    const memory = await memoryWith([
      'Hmph, you were up late again, human.',
      'You should sit down before the stream starts.',
    ])
    const view = await assemble({ memory, styleAnchors: true })
    // Both lines are eligible; the tic/address line scores higher and comes first.
    expect(view.styleAnchors.map((anchor) => anchor.turnId)).toEqual(['turn-1', 'turn-2'])

    const prompt = renderDialoguePrompt(view)
    const personaAt = prompt.indexOf(view.personaBlock)
    const headerAt = prompt.indexOf(STYLE_ANCHORS_HEADER)
    const anchorAt = prompt.indexOf('- Hmph, you were up late again, human.')
    expect(personaAt).toBeGreaterThanOrEqual(0)
    expect(headerAt).toBeGreaterThan(personaAt)
    expect(anchorAt).toBeGreaterThan(headerAt)
    // Header text itself.
    expect(STYLE_ANCHORS_HEADER).toBe('Voice reference (style only, not facts):')
    // The section sits before the history block, so it is adjacent to the persona.
    const historyAt = prompt.indexOf('Already said (confirmed spoken):')
    expect(historyAt).toBeGreaterThan(anchorAt)
  })

  it('places the anchors before a state block when one is present', async () => {
    const memory = await memoryWith(['Hmph, you were up late again, human.'])
    const capture: { view: AssembledDialogueContext | null } = { view: null }
    const port = createDialoguePort({
      clock: { nowMs: () => 1_000 },
      history: memory,
      textSource: capturingSource(capture),
      styleAnchors: true,
      state: { energy: 0.5, mood: 'calm', affection: 0.5 },
      stateProfile: undefined,
    } as never)
    await port.generate(authoredRequest(), createCallContext(), { segment: async () => {} })
    const view = capture.view
    if (view === null) throw new Error('context was not assembled')
    const prompt = renderDialoguePrompt(view)
    const anchorAt = prompt.indexOf(STYLE_ANCHORS_HEADER)
    expect(anchorAt).toBeGreaterThanOrEqual(0)
    if (view.stateBlock !== null) {
      expect(anchorAt).toBeLessThan(prompt.indexOf(view.stateBlock))
    }
  })

  it('charges only the entry lines to history, never the header', async () => {
    const memory = await memoryWith(['Hmph, you were up late again, human.'])
    const off = await assemble({ memory, styleAnchors: false })
    const on = await assemble({ memory, styleAnchors: true })
    expect(on.styleAnchors).toHaveLength(1)

    // `estimatedCharacters` grows by exactly the rendered entry line.
    const charged = renderStyleAnchorLines(on.styleAnchors)[0]?.length ?? 0
    expect(charged).toBeGreaterThan(0)
    expect(on.estimatedCharacters).toBe(off.estimatedCharacters + charged)
    expect(renderDialoguePrompt(on)).toContain('\n')
    // The header is rendered but not charged.
    expect(on.estimatedCharacters).not.toBe(off.estimatedCharacters + charged + STYLE_ANCHORS_HEADER.length)
  })

  it('leaves the prompt, budget numbers and character count byte-identical when disabled', async () => {
    const memory = await memoryWith([
      'Hmph, you were up late again, human.',
      'You should sit down before the stream starts.',
    ])
    const off = await assemble({ memory, styleAnchors: false })
    const prompt = renderDialoguePrompt(off)
    expect(prompt).not.toContain(STYLE_ANCHORS_HEADER)
    expect(off.styleAnchors).toEqual([])
    expect(off.styleAnchorExclusions).toEqual([])

    // Assembling the same input through a port that never receives the option
    // produces the same bytes: the switch defaults to off.
    const capture: { view: AssembledDialogueContext | null } = { view: null }
    const port = createDialoguePort({
      clock: { nowMs: () => 1_000 },
      history: memory,
      textSource: capturingSource(capture),
    })
    await port.generate(authoredRequest(), createCallContext(), { segment: async () => {} })
    const implicit = capture.view
    if (implicit === null) throw new Error('context was not assembled')
    expect(renderDialoguePrompt(implicit)).toBe(prompt)
    expect(implicit.estimatedCharacters).toBe(off.estimatedCharacters)
    // The library default is off.
    expect(STYLE_ANCHORS_ENABLED).toBe(false)
  })

  it('reports exclusions for stale-persona and budget drops without any memory text', async () => {
    // `turn-1` was spoken by a previous persona version, so it can never anchor.
    const memory = createDeliveryMemoryStore()
    await commit(memory, 'turn-1', 'Hmph, this was said by the old version of her.', '1')
    await commit(memory, 'turn-2', 'Hmph, you were up late again, human.')
    const view = await assemble({ memory, styleAnchors: true })
    expect(view.styleAnchors.map((anchor) => anchor.turnId)).toEqual(['turn-2'])
    expect(view.styleAnchorExclusions).toEqual([
      { sessionId: SESSION, turnId: 'turn-1', reason: 'stale-persona' },
    ])
    // A diagnostic carries the turn id and the reason, never the text.
    for (const exclusion of view.styleAnchorExclusions) {
      expect(JSON.stringify(exclusion)).not.toContain('Hmph, this was said')
      expect(Object.keys(exclusion).sort()).toEqual(['reason', 'sessionId', 'turnId'])
    }
  })

  it('drops an anchor that does not fit the history budget and reports it', async () => {
    const texts = [
      'Hmph, you were up late again, human, and the stream is over now.',
      'You should sit down before the stream starts.',
    ]
    const memory = await memoryWith(texts)
    const roomy = await assemble({ memory, styleAnchors: true })
    expect(roomy.styleAnchors.length).toBeGreaterThan(0)

    // A cap that still admits both history turns (113 characters) but leaves
    // room for only the first anchor line. 180 is derived, not guessed: the two
    // entry lines render to 66 and 47 characters, and charging the second
    // would exceed the cap.
    const tight = await assemble({
      memory,
      styleAnchors: true,
      request: authoredRequest({ maxCharacters: 180 }),
    })
    expect(roomy.styleAnchors).toHaveLength(2)
    expect(tight.styleAnchors.map((anchor) => anchor.turnId)).toEqual(['turn-1'])
    expect(tight.turns.map((turnEntry) => turnEntry.turnId)).toEqual(['turn-1', 'turn-2'])
    const budget = tight.styleAnchorExclusions.filter((entry) => entry.reason === 'budget')
    expect(budget.map((entry) => entry.turnId)).toEqual(['turn-2'])
    // Never rendered half: the dropped line is absent from the voice-reference
    // section, not truncated. (The turn itself is still in history as normal
    // text, which is a different block and is not what this checks.)
    const prompt = renderDialoguePrompt(tight)
    const section = prompt.slice(prompt.indexOf(STYLE_ANCHORS_HEADER))
    // The persona block itself contains blank lines, so cut at the first
    // section header that follows the voice-reference header instead.
    const nextSection = section.indexOf('\nAlready said (confirmed spoken):')
    const blockEnd = nextSection < 0 ? section.indexOf('\n\n') : nextSection
    const voiceSection = blockEnd < 0 ? section : section.slice(0, blockEnd)
    for (const exclusion of budget) {
      const source = roomy.styleAnchors.find((anchor) => anchor.turnId === exclusion.turnId)
      if (source === undefined) continue
      const line = renderStyleAnchorLines([source])[0]
      expect(line).toBeDefined()
      expect(voiceSection).not.toContain(line as string)
    }
    expect(tight.estimatedCharacters).toBeLessThanOrEqual(180)
  })

  it('never selects a turn the window or the budget already dropped', async () => {
    // Five turns, a two-turn window: only the newest two can be anchors.
    const memory = await memoryWith([
      'Hmph, this old line is outside the window.',
      'This old line is outside the window too.',
      'You should sit down before the stream starts.',
      'Hmph, the newest line still counts.',
    ])
    const view = await assemble({
      memory,
      styleAnchors: true,
      request: authoredRequest({ maxTurns: 2 }),
    })
    const kept = new Set(view.turns.map((turnEntry) => turnEntry.turnId))
    for (const anchor of view.styleAnchors) {
      expect(kept.has(anchor.turnId)).toBe(true)
    }
    // The two window turns are still the whole history: no anchor added a turn.
    expect(view.turns).toHaveLength(2)
  })

  it('leaves the harness fixture profile unaffected when the switch is off', async () => {
    const memory = createDeliveryMemoryStore()
    const capture: { view: AssembledDialogueContext | null } = { view: null }
    const port = createDialoguePort({
      clock: { nowMs: () => 1_000 },
      history: memory,
      textSource: capturingSource(capture),
    })
    await port.generate(
      fixtureDialogueRequest({
        characterProfileId: FIXTURE_CHARACTER_PROFILE.profileId,
        characterProfileVersion: FIXTURE_CHARACTER_PROFILE.version,
      }),
      createCallContext(),
      { segment: async () => {} },
    )
    const view = capture.view
    if (view === null) throw new Error('context was not assembled')
    expect(view.styleAnchors).toEqual([])
    expect(view.styleAnchorExclusions).toEqual([])
    expect(renderDialoguePrompt(view)).not.toContain(STYLE_ANCHORS_HEADER)
  })

  it('does not depend on the reply intent or the recall ranking', async () => {
    const memory = await memoryWith(['Hmph, you were up late again, human.'])
    // The anchor set is the same for every intent: this section is about voice,
    // not about what the turn is answering.
    const seen = new Set<string>()
    for (const intent of REPLY_INTENTS) {
      const view = await assemble({
        memory,
        styleAnchors: true,
        request: fixtureDialogueRequest({
          characterProfileId: PROFILE_FOR_ASSEMBLY.profileId,
          characterProfileVersion: PROFILE_FOR_ASSEMBLY.version,
          selectedInput: { eventId: 'none', text: 'Good evening.' },
          responsePlan: {
            selectionRequestId: 'selection-req-1',
            selectedEventId: 'none',
            replyIntent: intent,
            policyVersion: 'policy-v1',
          },
          contextLimits: { maxTurns: 8, maxCharacters: 2_000 },
        }),
      })
      seen.add(view.styleAnchors.map((anchor) => anchor.turnId).join(','))
    }
    expect([...seen]).toEqual(['turn-1'])
  })
})
