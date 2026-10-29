import { describe, it } from 'vitest'
import { readLiveTextProviderConfig } from './live-config'

/*
 * Live acceptance harness for M4-02's real DialogueTextSource.
 *
 * The three cases below are the acceptance criteria recorded in
 * docs/team/HANDOFF-M4-01.en.md ("Wire a real DialogueTextSource in M4-02"):
 * a provider call with schema-valid usage, no fixture fallback on a missing
 * key, and no credential in the repository. They stay executable placeholders
 * until that implementation lands, so the acceptance harness exists before the
 * code it will judge; when M4-02 arrives these become real assertions against
 * `createDialoguePort` driven by the live provider from live-config.ts.
 *
 * The suite skips itself when the provider environment is not configured, so
 * running it without credentials is a clean skip, never a failure.
 */
const report = readLiveTextProviderConfig()

describe.skipIf(!report.available)('M4 live text source (M4-02 acceptance)', () => {
  it.todo('returns schema-valid usage from a real provider call')
  it.todo('fails instead of falling back to the fixture source when the key is missing')
  it.todo('keeps the credential out of the repository, the logs and the error messages')
})
