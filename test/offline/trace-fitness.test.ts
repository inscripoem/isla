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
})
