import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { usageRecordSchema } from '../../src/contracts'
import type { DialogueEnd, DialogueSegment, DialogueSink } from '../../src/contracts'
import { createDialoguePort, createOpenAiCompatibleTextSource } from '../../src/dialogue'
import type { DialogueOutcomeReport } from '../../src/dialogue'
import { createCallContext } from '../support/context'
import { fixtureDialogueRequest } from '../support/fixture-data'
import { readLiveTextProviderConfig } from './live-config'

/*
 * Live acceptance harness for M4-02's real DialogueTextSource.
 *
 * The three cases below are the acceptance criteria recorded in
 * docs/team/HANDOFF-M4-01.en.md ("Wire a real DialogueTextSource in M4-02"):
 * a provider call with schema-valid usage, no fixture fallback on a missing
 * key, and no credential in the repository. They assert against
 * `createDialoguePort` driven by the live provider from live-config.ts, and by
 * `createOpenAiCompatibleTextSource` for the configuration-fault cases.
 *
 * The suite skips itself when the provider environment is not configured, so
 * running it without credentials is a clean skip, never a failure. Nothing is
 * constructed at module scope beyond reading that configuration report; every
 * source and port is built inside a case.
 *
 * Credential rules (AGENTS.md): the configured credential is compared, never
 * printed. No case logs a key, interpolates one into a message, or shows a
 * matched file's contents.
 */
const report = readLiveTextProviderConfig()

/** Wall-clock domain, matching `Date.now()`-based deadlines built below. */
const clock = { nowMs: () => Date.now() }

/**
 * How long a live call is left in flight before a Stop is sent. This suite forbids
 * stubs and mocks, so the transport cannot signal "headers received" or "body
 * read started"; a short fixed window lands the revoke while a real completion is
 * still being produced, without stretching the case towards the suite timeout.
 */
const IN_FLIGHT_WINDOW_MS = 250

/**
 * Upper bound for awaiting a live call after its own Stop or deadline. It only
 * guards against a hang: the guard's rejection is the case's failure, never a
 * substitute verdict, and it stays well under the live config's 30 s timeout.
 */
const HANG_GUARD_MS = 20_000

/** Resolves after `ms`, used to hold a live call in flight before a Stop. */
function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}

/** Collects the segments a port emits. A sink write resolves once the segment is kept. */
function collectingSink(): DialogueSink & { readonly segments: DialogueSegment[] } {
  const segments: DialogueSegment[] = []
  return {
    segments,
    segment: async (segment) => {
      segments.push(segment)
    },
  }
}

/**
 * Directories the repository scan does not enter. Installed dependencies and
 * caches are not repository text the credential rule is about, so skipping them
 * keeps the scan's cost and result independent of what happens to be installed.
 */
const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set(['node_modules', '.cache'])

/** Recursively lists regular files under `root`, in a stable order, skipping dependency directories. */
function listFiles(root: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue
      found.push(...listFiles(path))
    } else if (entry.isFile()) found.push(path)
  }
  return found
}

/** Repository root, derived from this file's location, independent of the working directory. */
function repositoryRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
}

describe.skipIf(!report.available)('M4 live text source (M4-02 acceptance)', () => {
  it('returns schema-valid usage from a real provider call', async () => {
    const config = report.config!
    const textSource = createOpenAiCompatibleTextSource(config)
    const port = createDialoguePort({ clock, textSource })
    const sink = collectingSink()

    const request = fixtureDialogueRequest()
    const end: DialogueEnd = await port.generate(request, createCallContext(Date.now() + 60_000), sink)

    /* A live provider call that completed: the acceptance criterion itself. */
    expect(end.status).toBe('completed')

    /*
     * Schema-valid usage. `DialogueEnd` is already parsed by the port; re-parsing
     * the record proves validity explicitly rather than by inference.
     */
    expect(() => usageRecordSchema.parse(end.usage)).not.toThrow()

    /* Truthful usage: absent counts stay `usageMissing`, present counts are measured. */
    expect(end.usage.usageMissing).toBe(
      end.usage.inputTokens === null || end.usage.outputTokens === null,
    )

    /* Served identity is either unknown or a per-call value; never blank. */
    if (end.usage.resolvedModel !== null) {
      expect(end.usage.resolvedModel.trim().length).toBeGreaterThan(0)
    }
    /* The requested identity is the configured model, whichever model served the call. */
    expect(end.usage.requestedModel).toBe(config.model)

    /* Every emitted segment is non-empty speech attributed to the requested model. */
    expect(sink.segments.length).toBe(end.segmentCount)
    for (const segment of sink.segments) {
      expect(typeof segment.text).toBe('string')
      expect(segment.text.trim().length).toBeGreaterThan(0)
      expect(segment.model).toBe(config.model)
    }
  })

  it('fails instead of falling back to the fixture source when the key is missing', async () => {
    const config = report.config!
    const textSource = createOpenAiCompatibleTextSource({ ...config, apiKey: '' })
    const outcomes: DialogueOutcomeReport[] = []
    const port = createDialoguePort({
      clock,
      textSource,
      onOutcome: (outcome) => {
        outcomes.push(outcome)
      },
    })
    const sink = collectingSink()

    /*
     * A single failing call: it is awaited once so that its rejection is inspected
     * below and exactly one outcome report is emitted for the whole case.
     */
    const request = fixtureDialogueRequest()
    let failure: unknown
    try {
      await port.generate(request, createCallContext(Date.now() + 60_000), sink)
    } catch (error) {
      failure = error
    }

    /* The call FAILS: a rejection, not a completed end carrying substitute text. */
    expect(failure).toBeInstanceOf(Error)

    /*
     * Exactly one outcome report for the failing call, and it says so: nothing was
     * generated, nothing reached the sink, nothing was discarded.
     */
    expect(outcomes).toHaveLength(1)
    const outcome = outcomes[0]!
    expect(outcome.endStatus).toBe('failed')
    expect(outcome.usageStatus).toBe('failed')
    expect(outcome.generated).toBe(0)
    expect(outcome.emitted).toBe(0)
    expect(outcome.discarded).toBe(0)

    /* Fixture-fallback guard: no segment was emitted at all. */
    expect(sink.segments).toHaveLength(0)
  })

  it('keeps the credential out of the repository, the logs and the error messages', async () => {
    const config = report.config!

    /*
     * Error-message no-echo. An unreachable endpoint makes the provider call fail;
     * the rejection names the fault only. A distinctive response-body marker is
     * used as the body-like text that must never be echoed: the source reports
     * status and reason, never a response body.
     */
    const closedEndpoint = createOpenAiCompatibleTextSource({
      ...config,
      baseUrl: 'http://127.0.0.1:9/v1',
    })
    const closedPort = createDialoguePort({ clock, textSource: closedEndpoint })
    let closedMessage = ''
    try {
      await closedPort.generate(
        fixtureDialogueRequest(),
        createCallContext(Date.now() + 60_000),
        collectingSink(),
      )
      closedMessage = ''
    } catch (error) {
      closedMessage = error instanceof Error ? error.message : ''
    }
    expect(closedMessage.length).toBeGreaterThan(0)
    expect(closedMessage.includes(config.apiKey)).toBe(false)
    expect(closedMessage).not.toContain('response-body-never-echoed')

    /* The blank-key fault message is checked the same way: it names the fault, not the value. */
    const blankKeySource = createOpenAiCompatibleTextSource({ ...config, apiKey: '' })
    const blankKeyPort = createDialoguePort({ clock, textSource: blankKeySource })
    let blankKeyMessage = ''
    try {
      await blankKeyPort.generate(
        fixtureDialogueRequest(),
        createCallContext(Date.now() + 60_000),
        collectingSink(),
      )
      blankKeyMessage = ''
    } catch (error) {
      blankKeyMessage = error instanceof Error ? error.message : ''
    }
    expect(blankKeyMessage.length).toBeGreaterThan(0)
    expect(blankKeyMessage.includes(config.apiKey)).toBe(false)

    /*
     * Repository scan. Every file under src/dialogue/, every file under test/live/
     * and the environment template must stay credential-free. Only a path list is
     * reported on failure; no file text and no key value is ever printed.
     */
    const root = repositoryRoot()
    const scanned = [
      ...listFiles(join(root, 'src', 'dialogue')),
      ...listFiles(join(root, 'test', 'live')),
      join(root, '.env.example'),
    ]
    expect(scanned.length).toBeGreaterThan(0)

    const offenders = scanned.filter((path) => readFileSync(path, 'utf8').includes(config.apiKey))
    /* Paths only: a matching file's contents are never shown. */
    expect(offenders.map((path) => path.slice(root.length + 1))).toEqual([])
  })

  /*
   * Deadline on the live path: an expired deadline must end the call as
   * `deadline_exceeded`/`timeout` with nothing emitted, mirroring the offline
   * precedent. Honest limitation: the port's deadline gate is a local check
   * against the injected clock, so on this path the gate may decide before the
   * request reaches the wire. What is proven is the observable contract on the
   * live-configured source - an expired deadline ends the call as a timeout with
   * nothing emitted, and the presence of a real text source does not fall back to
   * a `completed` fixture reply.
   */
  it('ends a real-source call as deadline_exceeded when the deadline has already passed', async () => {
    const config = report.config!
    const textSource = createOpenAiCompatibleTextSource(config)
    const outcomes: DialogueOutcomeReport[] = []
    const port = createDialoguePort({
      clock,
      textSource,
      onOutcome: (outcome) => {
        outcomes.push(outcome)
      },
    })
    const sink = collectingSink()

    /*
     * An already-past deadline. The gate compares with `>=`, so the deadline has
     * expired by the time `generate` runs its checks; any later boundary sees the
     * same expired deadline.
     */
    const end: DialogueEnd = await port.generate(
      fixtureDialogueRequest(),
      createCallContext(Date.now() + 1),
      sink,
    )

    /* The visible outcome: a timeout, not a completed reply from the real source. */
    expect(end.status).toBe('deadline_exceeded')
    expect(end.usage.status).toBe('timeout')

    /* Zero segments: nothing was emitted before the expiry was observed. */
    expect(end.segmentCount).toBe(0)
    expect(sink.segments).toHaveLength(0)

    /*
     * Exactly one truthful outcome report. `generated` is deliberately not pinned:
     * the gate may trip at the pre-flight check or at a later await boundary if the
     * clock read races the boundary, and the accounting identity holds on both.
     */
    expect(outcomes).toHaveLength(1)
    const outcome = outcomes[0]!
    expect(outcome.endStatus).toBe('deadline_exceeded')
    expect(outcome.usageStatus).toBe('timeout')
    expect(outcome.emitted).toBe(0)
    expect(outcome.generated).toBe(outcome.discarded)
    const discardsSum = Object.values(outcome.discards).reduce((total, count) => total + count, 0)
    expect(discardsSum).toBe(outcome.discarded)
  })

  /*
   * Stop on the live path: a revoke that arrives during an in-flight real call
   * must end the call as `cancelled`/`cancelled` with nothing emitted and exactly
   * one truthful outcome, mirroring the offline body-read-abort precedent.
   * Honest limitation: without instrumenting the transport (this suite forbids
   * stubs and mocks) the exact wire phase at which the revoke lands - request
   * dispatch, headers or body read - is not observable on a live endpoint. The
   * fixed short window exists to land the revoke while a real completion is still
   * being produced. What is proven is the observable revocation contract on the
   * live path; if a provider ever answered within the window, the `cancelled`
   * assertion below fails loudly rather than passing falsely.
   */
  it('ends an in-flight real-provider call as cancelled when the turn is revoked mid-request', async () => {
    const config = report.config!
    const textSource = createOpenAiCompatibleTextSource(config)
    const outcomes: DialogueOutcomeReport[] = []
    const port = createDialoguePort({
      clock,
      textSource,
      onOutcome: (outcome) => {
        outcomes.push(outcome)
      },
    })
    const sink = collectingSink()

    /* A valid deadline: this case is about the Stop, not the timeout. */
    const context = createCallContext(Date.now() + 60_000)
    const pending = port.generate(fixtureDialogueRequest(), context, sink)

    /* Let the request go in flight, then revoke the turn. */
    await delay(IN_FLIGHT_WINDOW_MS)
    context.abort()

    /*
     * Await the call raced against a hang guard. If the guard fires the case FAILS
     * with its rejection; it never produces a passing verdict of its own.
     */
    let guardTimer: ReturnType<typeof setTimeout> | undefined
    const hangGuard = new Promise<never>((_, reject) => {
      guardTimer = setTimeout(() => {
        reject(
          new Error(
            `real-provider call did not settle within ${HANG_GUARD_MS} ms after the turn was revoked`,
          ),
        )
      }, HANG_GUARD_MS)
    })
    let end: DialogueEnd
    try {
      end = await Promise.race([pending, hangGuard])
    } finally {
      clearTimeout(guardTimer)
    }
    /*
     * A late rejection must never surface as an unhandled rejection; the awaited
     * result above is what is asserted.
     */
    void pending.catch(() => {})

    /* The visible outcome: a revocation, not a completed or failed reply. */
    expect(end.status).toBe('cancelled')
    expect(end.usage.status).toBe('cancelled')

    /* Zero segments: the Stop arrived before any candidate could reach the sink. */
    expect(end.segmentCount).toBe(0)
    expect(sink.segments).toHaveLength(0)

    /*
     * Exactly one truthful outcome report. `generated` is not pinned: it is zero
     * when the source returned nothing on the revoked signal, and positive only if
     * the provider answered within the in-flight window.
     */
    expect(outcomes).toHaveLength(1)
    const outcome = outcomes[0]!
    expect(outcome.endStatus).toBe('cancelled')
    expect(outcome.usageStatus).toBe('cancelled')
    expect(outcome.emitted).toBe(0)
    expect(outcome.generated).toBe(outcome.discarded)
    const discardsSum = Object.values(outcome.discards).reduce((total, count) => total + count, 0)
    expect(discardsSum).toBe(outcome.discarded)

    /* Candidates produced before the revoke are accounted as `aborted`. */
    if (outcome.generated > 0) {
      expect(outcome.discards['aborted'] ?? 0).toBeGreaterThanOrEqual(1)
    }
  })
})
