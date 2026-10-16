import { describe, expect, it } from 'vitest'
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
  }
}

function codes(base: TraceFs, overrides: Record<string, string>): string[] {
  return collectTraceViolations(overridden(base, overrides)).map((violation) => violation.code)
}

describe('traceability fitness functions (C-34)', () => {
  it('reports no violations on the committed repository', () => {
    expect(collectTraceViolations(nodeTraceFs(ROOT))).toEqual([])
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
