import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CHANGED_FILES_ENV, readChangedFiles } from '../../src/evaluation/changed-files'
import {
  nodeRestorationGit,
  readRestorationContext,
  type FileStat,
  type GitCommand,
  type PathEntry,
  type RestorationContext,
  type RestorationGit,
} from '../../src/evaluation/frozen-restoration'
import {
  collectTraceViolations,
  nodeTraceFs,
  type TraceFs,
} from '../../src/evaluation/trace-fitness'

const ROOT = process.cwd()

/** Wrap the real filesystem view, overriding individual files to inject defects. */
function overridden(base: TraceFs, overrides: Record<string, string>): TraceFs {
  return {
    read: (path) => overrides[path] ?? base.read(path),
    exists: (path) => (path in overrides ? true : base.exists(path)),
    list: (path) => base.list(path),
    stat: (path) => base.stat?.(path) ?? null,
  }
}

function codes(base: TraceFs, overrides: Record<string, string>): string[] {
  return collectTraceViolations(overridden(base, overrides)).map((violation) => violation.code)
}

describe('traceability fitness functions (C-34)', () => {
  it('reports no violations on the committed repository', () => {
    // In CI the changed-file list spans the push range (`before..HEAD`) and the
    // workflow pins the default-branch revision; the gate verifies it before any
    // frozen path is exempted. Locally the context is absent and the check is strict.
    const restoration = readRestorationContext()
    if (restoration !== null) {
      process.stderr.write(`trace: verified restoration baseline ${restoration.baseline}\n`)
    }
    const violations = collectTraceViolations(nodeTraceFs(ROOT), {
      changedFiles: readChangedFiles(),
      restoration: restoration ?? undefined,
      onRestoration: (message) => process.stderr.write(`trace: ${message}\n`),
    })
    expect(violations).toEqual([])
  })

  it('enforces the frozen manifest against the changed-file list CI supplies', () => {
    // The same path CI uses: the list comes from CHANGED_FILES_FILE. Without this,
    // the frozen check only ever runs in an isolated unit test and never against a
    // real pull request's diff.
    const dir = mkdtempSync(join(tmpdir(), 'trace-changed-'))
    const list = join(dir, 'changed.txt')
    writeFileSync(list, 'src/contracts/app/ports.ts\0')
    const previous = process.env[CHANGED_FILES_ENV]
    process.env[CHANGED_FILES_ENV] = list
    try {
      const found = collectTraceViolations(nodeTraceFs(ROOT), {
        changedFiles: readChangedFiles(),
      }).map((violation) => violation.code)
      expect(found).toContain('frozen-modified')
    } finally {
      if (previous === undefined) delete process.env[CHANGED_FILES_ENV]
      else process.env[CHANGED_FILES_ENV] = previous
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('treats a missing or empty changed-file path as a successful empty diff', () => {
    const dir = mkdtempSync(join(tmpdir(), 'trace-changed-'))
    const empty = join(dir, 'empty.txt')
    writeFileSync(empty, '')
    const previous = process.env[CHANGED_FILES_ENV]
    process.env[CHANGED_FILES_ENV] = empty
    try {
      expect(readChangedFiles()).toEqual([])
      expect(collectTraceViolations(nodeTraceFs(ROOT), { changedFiles: readChangedFiles() })).toEqual([])
    } finally {
      if (previous === undefined) delete process.env[CHANGED_FILES_ENV]
      else process.env[CHANGED_FILES_ENV] = previous
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('traceability fitness functions reject defects (C-35)', () => {
  const trace = 'docs/architecture/trace-matrix.md'

  it('flags a trace row referencing a missing component', () => {
    const base = nodeTraceFs(ROOT)
    const mutated = base
      .read(trace)
      .replace('src/storage/event-store.ts', 'src/storage/does-not-exist.ts')
    expect(codes(base, { [trace]: mutated })).toContain('trace-component-missing')
  })

  it('flags a trace row referencing an unknown case', () => {
    const base = nodeTraceFs(ROOT)
    const mutated = base.read(trace).replace('C-25', 'C-99')
    expect(codes(base, { [trace]: mutated })).toContain('trace-case-unknown')
  })

  it('flags an ADR reference with no file', () => {
    const base = nodeTraceFs(ROOT)
    const path = 'docs/architecture/adr/005-restart-recovery.md'
    const mutated = `${base.read(path)}\nSee ADR-999 for details.\n`
    expect(codes(base, { [path]: mutated })).toContain('adr-missing')
  })

  it('flags a runtime-policy row with no fallback', () => {
    const base = nodeTraceFs(ROOT)
    const path = 'docs/architecture/runtime-policy-catalog.md'
    const mutated = [
      '| Failure mode | Detection | Response | Fallback | Owner |',
      '| --- | --- | --- | --- | --- |',
      '| X | Y | Z |  | M6 |',
    ].join('\n')
    expect(codes(base, { [path]: mutated })).toContain('runtime-policy-no-fallback')
  })

  it('flags an invariant that is not registered', () => {
    const base = nodeTraceFs(ROOT)
    const path = 'docs/architecture/invariants.md'
    const mutated = base.read(path).replace(/^\| INV-11 \|.*$/m, '')
    expect(codes(base, { [path]: mutated })).toContain('invariant-unregistered')
  })

  it('flags an invariant table without an Owner column', () => {
    const base = nodeTraceFs(ROOT)
    const path = 'docs/architecture/invariants.md'
    const mutated = base.read(path).replace('| Fallback | Owner |', '| Fallback | Role |')
    expect(codes(base, { [path]: mutated })).toContain('invariants-no-owner-column')
  })

  it('flags a trace row with no owner', () => {
    const base = nodeTraceFs(ROOT)
    const path = 'docs/architecture/trace-matrix.md'
    const mutated = base.read(path).replace(/\|\s*M6\s*\|\s*$/m, '|  |')
    expect(codes(base, { [path]: mutated })).toContain('trace-no-owner')
  })

  it('flags a modified frozen path', () => {
    const found = collectTraceViolations(nodeTraceFs(ROOT), {
      changedFiles: ['src/contracts/app/ports.ts'],
    }).map((violation) => violation.code)
    expect(found).toContain('frozen-modified')
  })
})

describe('verified main-baseline restoration (C-34/C-35, INV-13)', () => {
  const BLUEPRINT = 'architecture-blueprint.md'
  const BASELINE = 'b'.repeat(40)
  const HEAD = 'c'.repeat(40)
  const HEX = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/
  const BASELINE_TEXT = nodeTraceFs(ROOT).read(BLUEPRINT)
  const BASELINE_MANIFEST = [
    'frozen:',
    `  - ${BLUEPRINT}`,
    '  - src/contracts/app/ports.ts',
    '',
  ].join('\n')
  const BASE_ENTRY: PathEntry = { mode: '100644', oid: 'blob-baseline' }

  interface GitSpec {
    readonly head?: string | null
    readonly ancestor?: boolean
    readonly baseline?: string
    readonly entries?: Readonly<Record<string, PathEntry | undefined>>
    readonly files?: Readonly<Record<string, string | undefined>>
    readonly resolves?: Readonly<Record<string, string | null>>
  }

  /**
   * An injected git view: a valid restoration of `BLUEPRINT` unless a fact is
   * overridden. No repository is created or mutated.
   */
  function git(spec: GitSpec = {}): RestorationGit {
    const baseline = spec.baseline ?? BASELINE
    const entries: Record<string, PathEntry | undefined> = {
      [`${baseline}:${BLUEPRINT}`]: BASE_ENTRY,
      [`${HEAD}:${BLUEPRINT}`]: BASE_ENTRY,
      ...spec.entries,
    }
    const files: Record<string, string | undefined> = {
      [`${baseline}:docs/architecture/frozen.yaml`]: BASELINE_MANIFEST,
      [`${baseline}:${BLUEPRINT}`]: BASELINE_TEXT,
      ...spec.files,
    }
    return {
      head: () => (spec.head === undefined ? HEAD : spec.head),
      resolve: (rev) => spec.resolves?.[rev] ?? (HEX.test(rev) ? rev : null),
      isAncestor: () => spec.ancestor ?? true,
      entry: (rev, path) => entries[`${rev}:${path}`] ?? null,
      file: (rev, path) => files[`${rev}:${path}`] ?? null,
    }
  }

  function context(spec: GitSpec = {}): RestorationContext {
    return { baseline: spec.baseline ?? BASELINE, git: git(spec) }
  }

  function frozenCodes(spec: GitSpec = {}, view?: TraceFs): string[] {
    return collectTraceViolations(view ?? nodeTraceFs(ROOT), {
      changedFiles: [BLUEPRINT],
      restoration: context(spec),
    }).map((violation) => violation.code)
  }

  /** A view whose real checked file is `BLUEPRINT`, with facts overridden. */
  function checkedFile(spec: { readonly stat?: FileStat | null; readonly readThrows?: boolean }): TraceFs {
    const base = nodeTraceFs(ROOT)
    const statFor = (): FileStat | null =>
      spec.stat === undefined ? (base.stat?.(BLUEPRINT) ?? null) : spec.stat
    return {
      read: (path) => {
        if (path === BLUEPRINT && spec.readThrows === true) throw new Error('EACCES: permission denied')
        return base.read(path)
      },
      exists: (path) => (path === BLUEPRINT ? statFor() !== null : base.exists(path)),
      list: (path) => base.list(path),
      stat: (path) => (path === BLUEPRINT ? statFor() : (base.stat?.(path) ?? null)),
    }
  }

  it('accepts an exact restoration of the baseline content and mode', () => {
    expect(frozenCodes()).not.toContain('frozen-modified')
  })

  it('rejects a committed change whose blob differs from the baseline', () => {
    expect(
      frozenCodes({ entries: { [`${HEAD}:${BLUEPRINT}`]: { mode: '100644', oid: 'blob-edited' } } }),
    ).toContain('frozen-modified')
  })

  it('rejects a committed change whose mode differs from the baseline', () => {
    expect(
      frozenCodes({ entries: { [`${HEAD}:${BLUEPRINT}`]: { mode: '100755', oid: BASE_ENTRY.oid } } }),
    ).toContain('frozen-modified')
  })

  it('rejects a frozen path deleted at the checked head', () => {
    expect(frozenCodes({ entries: { [`${HEAD}:${BLUEPRINT}`]: undefined } })).toContain('frozen-modified')
  })

  it('rejects a dirty checked file even though the committed head matches the baseline', () => {
    // The coordinator's probe: the real git adapter says HEAD is the restored blob,
    // but the file actually present in the checkout is an uncommitted edit.
    const dirty = overridden(nodeTraceFs(ROOT), { [BLUEPRINT]: 'uncommitted local edit\n' })
    expect(frozenCodes({}, dirty)).toContain('frozen-modified')
  })

  it('rejects a checked file whose filesystem mode differs from the baseline', () => {
    expect(frozenCodes({}, checkedFile({ stat: { mode: '100755', regular: true } }))).toContain(
      'frozen-modified',
    )
  })

  it('rejects a symlink substituted at the checked path', () => {
    expect(frozenCodes({}, checkedFile({ stat: { mode: '120000', regular: false } }))).toContain(
      'frozen-modified',
    )
  })

  it('rejects a checked file that is deleted', () => {
    expect(frozenCodes({}, checkedFile({ stat: null }))).toContain('frozen-modified')
  })

  it('rejects a checked file that cannot be read', () => {
    expect(
      frozenCodes({}, checkedFile({ stat: { mode: '100644', regular: true }, readThrows: true })),
    ).toContain('frozen-modified')
  })

  it('preserves the reverse case: a committed change fails even when the working tree matches', () => {
    // The checked file equals the baseline text, but the committed head blob differs.
    expect(
      frozenCodes({ entries: { [`${HEAD}:${BLUEPRINT}`]: { mode: '100644', oid: 'blob-edited' } } }),
    ).toContain('frozen-modified')
  })

  it('rejects a path that is not frozen at the baseline', () => {
    expect(
      frozenCodes({
        files: { [`${BASELINE}:docs/architecture/frozen.yaml`]: 'frozen:\n  - src/contracts/app/ports.ts\n' },
      }),
    ).toContain('frozen-modified')
  })

  it('rejects a baseline whose frozen manifest is missing', () => {
    expect(
      frozenCodes({ files: { [`${BASELINE}:docs/architecture/frozen.yaml`]: undefined } }),
    ).toContain('frozen-modified')
  })

  it('rejects a baseline that is not an ancestor of the checked head', () => {
    expect(frozenCodes({ ancestor: false })).toContain('frozen-modified')
  })

  it('rejects an unresolvable checked head', () => {
    expect(frozenCodes({ head: null })).toContain('frozen-modified')
  })

  it('never lets a run approve its own head', () => {
    expect(frozenCodes({ baseline: HEAD })).toContain('frozen-modified')
  })

  it('denies a symbolic or abbreviated baseline even in a direct context', () => {
    expect(frozenCodes({ baseline: 'origin/main', resolves: { 'origin/main': BASELINE } })).toContain(
      'frozen-modified',
    )
    expect(frozenCodes({ baseline: 'HEAD' })).toContain('frozen-modified')
    expect(frozenCodes({ baseline: 'HEAD', resolves: { HEAD } })).toContain('frozen-modified')
    expect(frozenCodes({ baseline: 'c2f9b38' })).toContain('frozen-modified')
    expect(frozenCodes({ baseline: 'not a commit' })).toContain('frozen-modified')
  })

  it('logs the provenance of an accepted and a denied restoration', () => {
    const accepted: string[] = []
    collectTraceViolations(nodeTraceFs(ROOT), {
      changedFiles: [BLUEPRINT],
      restoration: context(),
      onRestoration: (message) => accepted.push(message),
    })
    expect(accepted).toEqual([expect.stringContaining(`restored to baseline ${BASELINE}`)])

    const denied: string[] = []
    collectTraceViolations(nodeTraceFs(ROOT), {
      changedFiles: [BLUEPRINT],
      restoration: context({ ancestor: false }),
      onRestoration: (message) => denied.push(message),
    })
    expect(denied).toEqual([expect.stringContaining('restoration denied')])
  })

  it('offers the exception only for a feature-branch push with a full commit id', () => {
    const push = {
      GITHUB_EVENT_NAME: 'push',
      GITHUB_REF_TYPE: 'branch',
      GITHUB_REF_NAME: 'feat/i1-application-loop',
      DEFAULT_BRANCH: 'main',
      TRUSTED_BASELINE_SHA: BASELINE,
    }
    expect(readRestorationContext({ ...push })?.baseline).toBe(BASELINE)

    expect(readRestorationContext({ ...push, GITHUB_REF_NAME: 'main' })).toBeNull()
    expect(readRestorationContext({ ...push, GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v1' })).toBeNull()
    expect(readRestorationContext({ ...push, GITHUB_EVENT_NAME: 'pull_request' })).toBeNull()
    expect(readRestorationContext({ ...push, GITHUB_EVENT_NAME: 'workflow_dispatch' })).toBeNull()
    expect(readRestorationContext({ ...push, TRUSTED_BASELINE_SHA: '' })).toBeNull()
    expect(readRestorationContext({ ...push, TRUSTED_BASELINE_SHA: '0'.repeat(40) })).toBeNull()
    expect(readRestorationContext({ ...push, DEFAULT_BRANCH: '' })).toBeNull()
    expect(readRestorationContext({ ...push, TRUSTED_BASELINE_SHA: 'origin/main' })).toBeNull()
    expect(readRestorationContext({ ...push, TRUSTED_BASELINE_SHA: 'c2f9b38' })).toBeNull()
    expect(readRestorationContext({ ...push, TRUSTED_BASELINE_SHA: 'HEAD' })).toBeNull()
  })

  it('keeps the strict default when no restoration context is offered', () => {
    const found = collectTraceViolations(nodeTraceFs(ROOT), {
      changedFiles: [BLUEPRINT],
    }).map((violation) => violation.code)
    expect(found).toContain('frozen-modified')
  })
})

describe('production restoration adapters (read-only facts, injected failures)', () => {
  it('resolves canonical commit ids and reads the real repository facts', () => {
    const git = nodeRestorationGit(ROOT)
    const head = git.head()
    expect(head).toMatch(/^[0-9a-f]{40}$/)
    expect(git.resolve('HEAD')).toBe(head)
    expect(git.resolve(head ?? '')).toBe(head)
    expect(git.isAncestor(head ?? '', head ?? '')).toBe(true)
    expect(git.entry(head ?? '', 'docs/architecture/frozen.yaml')).toEqual({
      mode: '100644',
      oid: expect.stringMatching(/^[0-9a-f]{40}$/),
    })
    expect(git.file(head ?? '', 'docs/architecture/frozen.yaml')).toContain('frozen:')
    expect(git.entry(head ?? '', 'no/such/path.ts')).toBeNull()
    expect(git.file(head ?? '', 'no/such/path.ts')).toBeNull()
    expect(git.resolve('definitely-not-a-ref')).toBeNull()
  })

  it('reports no ancestry for an unresolvable revision', () => {
    const git = nodeRestorationGit(ROOT)
    expect(git.isAncestor('f'.repeat(40), git.head() ?? 'HEAD')).toBe(false)
  })

  it('degrades safely when a git command fails', () => {
    const failing: GitCommand = () => ({ ok: false, stdout: new Uint8Array() })
    const git = nodeRestorationGit(ROOT, failing)
    expect(git.head()).toBeNull()
    expect(git.resolve('HEAD')).toBeNull()
    expect(git.isAncestor('a', 'b')).toBe(false)
    expect(git.entry('HEAD', 'x')).toBeNull()
    expect(git.file('HEAD', 'x')).toBeNull()
  })

  it('keeps exact file bytes for the content comparison (no trimming)', () => {
    const git = nodeRestorationGit(ROOT, () => ({
      ok: true,
      stdout: Buffer.from('line one\nline two\n', 'utf8'),
    }))
    expect(git.file('rev', 'path')).toBe('line one\nline two\n')
  })

  it('denies a blob whose bytes are not valid UTF-8 instead of replacing them', () => {
    const malformed: GitCommand = () => ({
      ok: true,
      stdout: Buffer.from([0x61, 0xff, 0xfe, 0x62]),
    })
    expect(nodeRestorationGit(ROOT, malformed).file('rev', 'path')).toBeNull()
  })

  it('reports the checked file mode and regularity, and null for an uninspectable path', () => {
    const fs = nodeTraceFs(ROOT)
    expect(fs.stat?.('architecture-blueprint.md')).toEqual({ mode: '100644', regular: true })
    expect(fs.stat?.('docs')).toEqual({ mode: '40000', regular: false })
    expect(fs.stat?.('no/such/path')).toBeNull()
  })

  it('denies a checked file whose bytes are not valid UTF-8 instead of replacing them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'isla-trace-utf8-'))
    try {
      writeFileSync(join(dir, 'malformed.md'), Buffer.from([0x61, 0xff, 0xfe, 0x62]))
      expect(() => nodeTraceFs(dir).read('malformed.md')).toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('owner-prefixed ids (structural-constraints.md §3)', () => {
  const REQUIRED = 'docs/req/requirements.yaml'
  const INVARIANTS = 'docs/architecture/invariants.md'
  const TRACE = 'docs/architecture/trace-matrix.md'

  it('recognises an owner-prefixed case id in a trace row', () => {
    const base = nodeTraceFs(ROOT)
    // Left unregistered on purpose: if the recogniser did not accept the prefixed
    // form it would skip the id and report nothing at all.
    const mutated = base.read(TRACE).replace('C-25', 'C-M6-1')
    expect(codes(base, { [TRACE]: mutated })).toContain('trace-case-unknown')
  })

  it('accepts a prefixed invariant whose Owner names the same module', () => {
    const base = nodeTraceFs(ROOT)
    const found = codes(base, {
      [REQUIRED]: base.read(REQUIRED).replace('- id: INV-12', '- id: INV-M6-12'),
      [INVARIANTS]: base.read(INVARIANTS).replace(/^\| INV-12 \|/m, '| INV-M6-12 |'),
    })
    expect(found).not.toContain('invariant-owner-mismatch')
    expect(found).not.toContain('invariant-unregistered')
  })

  it('flags a prefixed invariant whose Owner names a different module', () => {
    const base = nodeTraceFs(ROOT)
    const found = codes(base, {
      [REQUIRED]: base.read(REQUIRED).replace('- id: INV-12', '- id: INV-M6-12'),
      // The same row, but its Owner cell says M5 while the id claims M6.
      [INVARIANTS]: base
        .read(INVARIANTS)
        .replace(/^\| INV-12 \|(.*)\| M6 \|$/m, '| INV-M6-12 |$1| M5 |'),
    })
    expect(found).toContain('invariant-owner-mismatch')
  })

  it('leaves a legacy numeric id unchecked against the Owner cell', () => {
    const base = nodeTraceFs(ROOT)
    // A numeric id carries no module claim, so a mixed Owner cell is not a defect.
    const found = codes(base, {
      [INVARIANTS]: base.read(INVARIANTS).replace(/^\| INV-12 \|(.*)\| M6 \|$/m, '| INV-12 |$1| M5 |'),
    })
    expect(found).not.toContain('invariant-owner-mismatch')
  })
})
