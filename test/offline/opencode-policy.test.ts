import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runCli } from '../../tools/opencode/cli.ts'
import {
  APPROVAL_CLASSES,
  DEFAULT_AGENT,
  POLICY_PATH,
  ROLE_IDS,
  compileConfig,
  evaluateRules,
  metaPathFor,
  parsePolicy,
  resolveOutputPath,
  serializeConfig,
} from '../../tools/opencode/policy.ts'
import type { ApprovalClass, BuildConfig, ConfigRuntime, Policy, RoleId } from '../../tools/opencode/policy.ts'

const ROOT = process.cwd()
const POLICY_TEXT = readFileSync(join(ROOT, POLICY_PATH), 'utf8')
const POLICY = parsePolicy(POLICY_TEXT)

const TEST_MODEL = 'test-provider/test-model'
const OTHER_MODEL = 'test-provider/other-model'
const PLUGIN_NAME = 'oh-my-opencode-slim'
/** OpenCode V2 excludes a plugin with a leading hyphen. */
const EXCLUDED_PLUGIN = `-${PLUGIN_NAME}`

/** Root files every member is expected to read before starting a task. */
const MANDATORY_ROOT_READS = [
  'AGENTS.md',
  'Prompt.md',
  'README.md',
  'architecture-blueprint.md',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.json',
  'tsconfig.app.json',
  'tsconfig.node.json',
  'tsconfig.test.json',
  'vite.config.ts',
  'vitest.config.ts',
  '.oxlintrc.json',
  '.gitignore',
]

const tempRoots: string[] = []

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'opencode-policy-'))
  mkdirSync(join(root, '.opencode'), { recursive: true })
  writeFileSync(join(root, POLICY_PATH), POLICY_TEXT)
  tempRoots.push(root)
  return root
}

function run(args: readonly string[], cwd: string): { code: number; stdout: string; stderr: string } {
  let stdout = ''
  let stderr = ''
  const code = runCli(args, {
    cwd,
    stdout: (text) => {
      stdout += text
    },
    stderr: (text) => {
      stderr += text
    },
  })
  return { code, stdout, stderr }
}

const DEFAULT_RUNTIME: ConfigRuntime = { agent: DEFAULT_AGENT, model: TEST_MODEL, excludePlugins: [] }

function rulesFor(role: RoleId, grants: readonly ApprovalClass[] = []): BuildConfig {
  return compileConfig(POLICY, role, grants, ROOT, DEFAULT_RUNTIME)
}

function path(relative: string): string {
  return join(ROOT, relative)
}

function existingBase(pattern: string): string {
  const normalized = pattern.replaceAll('\\', '/')
  const wildcard = normalized.search(/[*?]/)
  if (wildcard === -1) return normalized
  // A wildcard can split a filename (test/offline/m4-*.test.ts), so only the
  // directory prefix is a path that is expected to exist.
  const prefix = normalized.slice(0, wildcard)
  const slash = prefix.lastIndexOf('/')
  return slash === -1 ? '.' : prefix.slice(0, slash)
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('policy source', () => {
  it('parses the committed policy and keeps the artifact under review', () => {
    expect(POLICY.status).toBe('under-review')
    expect(POLICY.defaultEffect).toBe('deny')
    expect(Object.keys(POLICY.roles).sort()).toEqual([...ROLE_IDS].sort())
    for (const key of ['agent', 'model', 'plugins']) {
      expect(Object.prototype.hasOwnProperty.call(POLICY, key), key).toBe(false)
    }
  })

  it('names only paths that exist, apart from generated output', () => {
    const patterns = [
      ...POLICY.read,
      ...Object.values(POLICY.roles).flatMap((role) => [...role.source, ...role.tests, ...role.handoffs]),
      ...Object.values(POLICY.approvals).flat(),
    ]
    for (const pattern of patterns) {
      const base = existingBase(pattern)
      if (base === '' || base === '.' || base === '.cache' || base.startsWith('.cache/')) continue
      expect(existsSync(join(ROOT, base)), `${pattern} resolves under ${base}`).toBe(true)
    }
  })

  it('keeps the frozen class equal to the frozen manifest', () => {
    const manifest = readFileSync(join(ROOT, 'docs/architecture/frozen.yaml'), 'utf8')
    for (const frozen of POLICY.approvals.frozen) {
      expect(manifest).toContain(`  - ${frozen}`)
    }
  })

  it('rejects a policy that removes a mandatory credential pattern', () => {
    const weakened = POLICY_TEXT.replace('      "**/*credential*",\n', '')
    expect(() => parsePolicy(weakened)).toThrow(/must include "\*\*\/\*credential\*"/)
  })

  it('rejects a policy that removes the delegation denial', () => {
    const weakened = POLICY_TEXT.replace('"actions": ["task"]', '"actions": []')
    expect(() => parsePolicy(weakened)).toThrow(/must include "task"/)
  })

  it('rejects an unknown key, committed provider/model/plugin keys and duplicate paths', () => {
    const extra = JSON.parse(POLICY_TEXT) as Record<string, unknown>
    extra.extra = true
    expect(() => parsePolicy(JSON.stringify(extra))).toThrow(/exactly the keys/)

    for (const [key, value] of [
      ['agent', 'build'],
      ['model', TEST_MODEL],
      ['plugins', [EXCLUDED_PLUGIN]],
    ] as const) {
      const withKey = JSON.parse(POLICY_TEXT) as Record<string, unknown>
      withKey[key] = value
      expect(() => parsePolicy(JSON.stringify(withKey)), key).toThrow(/exactly the keys/)
    }

    expect(() =>
      parsePolicy(POLICY_TEXT.replace('"source": ["src/runtime/**"]', '"source": ["src/runtime/**", "src/runtime/**"]')),
    ).toThrow(/duplicates/)
  })
})

describe('compiled configuration', () => {
  it('keeps one build agent, the supplied model and no plugin key by default', () => {
    const config = rulesFor('M5')
    expect(Object.keys(config.agents)).toEqual(['build'])
    expect(Object.prototype.hasOwnProperty.call(config, 'plugins')).toBe(false)
    expect(config.agents.build.disabled).toBe(false)
    expect(config.agents.build.model).toBe(TEST_MODEL)
    expect(Object.prototype.hasOwnProperty.call(config, 'permissions')).toBe(false)
    expect(config.agents.build.permissions[0]).toEqual({ action: '*', resource: '*', effect: 'deny' })
  })

  it('uses the supplied agent name and model instead of constants', () => {
    const config = compileConfig(POLICY, 'M5', [], ROOT, {
      agent: 'reviewer',
      model: OTHER_MODEL,
      excludePlugins: [],
    })
    expect(Object.keys(config.agents)).toEqual(['reviewer'])
    expect(config.agents.reviewer.model).toBe(OTHER_MODEL)
  })

  it('emits plugin exclusions only when supplied, in the leading-hyphen form', () => {
    const config = compileConfig(POLICY, 'M5', [], ROOT, {
      agent: DEFAULT_AGENT,
      model: TEST_MODEL,
      excludePlugins: [PLUGIN_NAME],
    })
    expect(config.plugins).toEqual([EXCLUDED_PLUGIN])
    expect(config.plugins).not.toContain(PLUGIN_NAME)
  })

  it('allows the role-owned source and denies another module write', () => {
    const rules = rulesFor('M5').agents.build.permissions
    expect(evaluateRules(rules, 'read', path('src/runtime/config.ts'))).toBe('allow')
    expect(evaluateRules(rules, 'edit', path('src/runtime/config.ts'))).toBe('allow')
    expect(evaluateRules(rules, 'write', path('test/offline/m5-runtime.test.ts'))).toBe('allow')
    expect(evaluateRules(rules, 'read', path('src/decision/selection.ts'))).toBe('allow')
    expect(evaluateRules(rules, 'edit', path('src/decision/selection.ts'))).toBe('deny')
    expect(evaluateRules(rules, 'edit', path('docs/team/HANDOFF-M5-01.en.md'))).toBe('allow')
  })

  it('reads every mandatory root file but keeps the blueprint frozen for writes', () => {
    const rules = rulesFor('M5').agents.build.permissions
    for (const file of MANDATORY_ROOT_READS) {
      expect(evaluateRules(rules, 'read', path(file)), file).toBe('allow')
      expect(evaluateRules(rules, 'glob', path(file)), file).toBe('allow')
    }
    expect(evaluateRules(rules, 'edit', path('architecture-blueprint.md'))).toBe('deny')
    expect(evaluateRules(rules, 'write', path('architecture-blueprint.md'))).toBe('deny')

    const sharedOnly = rulesFor('M5', ['shared_contracts']).agents.build.permissions
    expect(evaluateRules(sharedOnly, 'edit', path('architecture-blueprint.md'))).toBe('deny')

    const frozen = rulesFor('M5', ['frozen']).agents.build.permissions
    expect(evaluateRules(frozen, 'read', path('architecture-blueprint.md'))).toBe('allow')
    expect(evaluateRules(frozen, 'edit', path('architecture-blueprint.md'))).toBe('allow')
  })

  it('keeps the narrowed credential boundary and ordinary source names readable', () => {
    const rules = rulesFor('M5').agents.build.permissions
    for (const allowed of [
      'src/dialogue/delivery-key.ts',
      'src/runtime/control-authorizer.ts',
      'docs/team/README.md',
    ]) {
      expect(evaluateRules(rules, 'read', path(allowed)), allowed).toBe('allow')
    }

    for (const denied of [
      '.env',
      '.env.example',
      '.env.local',
      'id_rsa',
      'server.pem',
      'client.p12',
      'private.key',
      '.ssh/config',
      '.aws/credentials',
      'docs/team/example-token.txt',
    ]) {
      expect(evaluateRules(rules, 'read', path(denied)), denied).toBe('deny')
    }

    expect(evaluateRules(rules, 'read', '/etc/passwd')).toBe('deny')
  })

  it('requires the frozen approval in addition to the shared-contract approval', () => {
    const shared = rulesFor('M5', ['shared_contracts']).agents.build.permissions
    expect(evaluateRules(shared, 'edit', path('src/contracts/app/primitives.ts'))).toBe('allow')
    expect(evaluateRules(shared, 'edit', path('src/contracts/app/ports.ts'))).toBe('deny')

    const frozen = rulesFor('M5', ['frozen']).agents.build.permissions
    expect(evaluateRules(frozen, 'edit', path('src/contracts/app/ports.ts'))).toBe('allow')
    expect(evaluateRules(frozen, 'edit', path('src/contracts/app/primitives.ts'))).toBe('deny')

    const both = rulesFor('M5', ['shared_contracts', 'frozen']).agents.build.permissions
    expect(evaluateRules(both, 'edit', path('src/contracts/app/ports.ts'))).toBe('allow')
  })

  it('keeps protected paths denied even with every approval class', () => {
    const rules = rulesFor('M5', APPROVAL_CLASSES).agents.build.permissions
    expect(evaluateRules(rules, 'edit', path('docs/architecture/permission-model.md'))).toBe('allow')
    expect(evaluateRules(rules, 'edit', path('opencode.json'))).toBe('deny')
    expect(evaluateRules(rules, 'edit', path('docs/architecture/frozen.yaml'))).toBe('deny')
    expect(evaluateRules(rules, 'edit', path('.opencode/permissions.jsonc'))).toBe('deny')
    expect(evaluateRules(rules, 'edit', path('.opencode/rules.md'))).toBe('deny')
    expect(evaluateRules(rules, 'edit', path('.agent/rules.md'))).toBe('deny')
    expect(evaluateRules(rules, 'edit', path('tools/opencode/policy.ts'))).toBe('deny')
    expect(evaluateRules(rules, 'read', path('.env'))).toBe('deny')
  })

  it('denies delegation and keeps shell narrow', () => {
    const rules = rulesFor('M5').agents.build.permissions
    expect(evaluateRules(rules, 'task', 'anything')).toBe('deny')
    expect(evaluateRules(rules, 'shell', 'git status --short')).toBe('allow')
    expect(evaluateRules(rules, 'shell', 'pnpm test:m5')).toBe('allow')
    expect(evaluateRules(rules, 'shell', 'git commit -m x')).toBe('deny')
    expect(evaluateRules(rules, 'shell', 'git add --dry-run -- .')).toBe('deny')
    expect(evaluateRules(rules, 'shell', 'gh --version')).toBe('deny')
    expect(evaluateRules(rules, 'shell', 'pnpm exec vitest run')).toBe('deny')
  })

  it('allows only the observed RTK rewrite forms', () => {
    const rules = rulesFor('M5').agents.build.permissions
    for (const command of [
      'git status --short',
      'rtk git status --short',
      'git diff --stat',
      'rtk git diff --stat',
      'git diff',
      'rtk git diff',
      'pnpm lint',
      'rtk lint',
    ]) {
      expect(evaluateRules(rules, 'shell', command), command).toBe('allow')
    }

    for (const command of [
      'rtk',
      'rtk git status',
      'rtk git status --short --extra',
      'rtk git commit -m x',
      'rtk git push',
      'rtk git add -- .',
      'rtk gh pr merge 1',
      'rtk pnpm publish',
      'rtk npm publish',
      'rtk rm -rf .',
      'rtk cat package.json',
      'rtk lint --fix',
      'rtk proxy git status --short',
      'proxy git status --short',
      'rtk exec git status --short',
      'pnpm exec vitest run',
      'rtk vitest run',
      'git status --short && node --version',
    ]) {
      expect(evaluateRules(rules, 'shell', command), command).toBe('deny')
    }
  })

  it('rejects unknown roles and approval classes', () => {
    expect(() => compileConfig(POLICY, 'M7' as RoleId, [], ROOT, DEFAULT_RUNTIME)).toThrow(/unknown role/)
    expect(() => compileConfig(POLICY, 'M5', ['bogus' as ApprovalClass], ROOT, DEFAULT_RUNTIME)).toThrow(
      /unknown approval class/,
    )
  })

  it('assigns the merged voice tests to their owning roles', () => {
    const owned: Record<string, string[]> = {
      M1: ['test/browser/root-entry-audio-browser.mjs'],
      M2: ['test/offline/console-voice-selection.test.ts', 'test/browser/console-voice-selection.mjs'],
      M5: ['test/offline/voice-settings.test.ts'],
    }
    for (const [role, files] of Object.entries(owned)) {
      const own = rulesFor(role as RoleId).agents.build.permissions
      const other = rulesFor('M6').agents.build.permissions
      for (const file of files) {
        expect(evaluateRules(own, 'edit', path(file)), `${role} ${file}`).toBe('allow')
        expect(evaluateRules(own, 'write', path(file)), `${role} ${file}`).toBe('allow')
        expect(evaluateRules(other, 'edit', path(file)), `${role} ${file}`).toBe('deny')
      }
    }
  })

  it('serializes deterministically', () => {
    const first = serializeConfig(rulesFor('M5'))
    const second = serializeConfig(rulesFor('M5'))
    expect(first).toBe(second)
    expect(first.endsWith('\n')).toBe(true)
  })
})

describe('output path safety', () => {
  it('accepts only paths inside the generated-output directory', () => {
    expect(resolveOutputPath(ROOT, '.cache/opencode/m5-M5-01.json')).toBe(
      join(ROOT, '.cache/opencode/m5-M5-01.json'),
    )
    expect(() => resolveOutputPath(ROOT, '../escape.json')).toThrow(/must not contain/)
    expect(() => resolveOutputPath(ROOT, '.cache/opencode/../escape.json')).toThrow(/must not contain/)
    expect(() => resolveOutputPath(ROOT, '/tmp/escape.json')).toThrow(/relative/)
    expect(() => resolveOutputPath(ROOT, '.opencode/permissions.jsonc')).toThrow(/inside/)
    expect(() => resolveOutputPath(ROOT, 'tools/opencode/x.json')).toThrow(/inside/)
  })

  it('derives the sidecar path next to the config', () => {
    expect(metaPathFor('/x/a.json')).toBe('/x/a.meta.json')
    expect(metaPathFor('/x/a')).toBe('/x/a.meta.json')
  })
})

describe('cli', () => {
  it('writes a config and sidecar, then checks them', () => {
    const root = makeRoot()
    const out = '.cache/opencode/m5-M5-01.json'
    const args = ['--role', 'M5', '--task', 'M5-01', '--model', TEST_MODEL, '--out', out]
    const result = run(args, root)
    expect(result.code).toBe(0)
    const target = join(root, out)
    expect(existsSync(target)).toBe(true)
    const parsed = JSON.parse(readFileSync(target, 'utf8')) as {
      plugins?: string[]
      agents: Record<string, { model: string }>
    }
    expect(Object.prototype.hasOwnProperty.call(parsed, 'plugins')).toBe(false)
    expect(parsed.agents.build.model).toBe(TEST_MODEL)
    const meta = JSON.parse(readFileSync(join(root, '.cache/opencode/m5-M5-01.meta.json'), 'utf8')) as {
      status: string
      grants: string[]
      agent: string
      model: string
      excludePlugins: string[]
    }
    expect(meta.status).toBe('under-review')
    expect(meta.grants).toEqual([])
    expect(meta.agent).toBe('build')
    expect(meta.model).toBe(TEST_MODEL)
    expect(meta.excludePlugins).toEqual([])

    const checked = run(['--role', 'M5', '--task', 'M5-01', '--model', TEST_MODEL, '--check', out], root)
    expect(checked.code).toBe(0)
    expect(checked.stdout).toContain('ok ')
  })

  it('requires --model for every invocation', () => {
    const root = makeRoot()
    const out = '.cache/opencode/m5-M5-01.json'
    expect(run(['--role', 'M5', '--task', 'M5-01'], root).code).toBe(1)
    expect(run(['--role', 'M5', '--task', 'M5-01', '--out', out], root).code).toBe(1)
    const checked = run(['--role', 'M5', '--task', 'M5-01', '--check', out], root)
    expect(checked.code).toBe(1)
    expect(checked.stderr).toContain('--model is required')
  })

  it('reports drift instead of accepting a changed file', () => {
    const root = makeRoot()
    const out = '.cache/opencode/m5-M5-01.json'
    expect(run(['--role', 'M5', '--task', 'M5-01', '--model', TEST_MODEL, '--out', out], root).code).toBe(0)
    const target = join(root, out)
    writeFileSync(target, readFileSync(target, 'utf8').replace('"build"', '"other"'))
    const checked = run(['--role', 'M5', '--task', 'M5-01', '--model', TEST_MODEL, '--check', out], root)
    expect(checked.code).toBe(1)
    expect(checked.stderr).toContain('drift:')
  })

  it('refuses an accidental overwrite and allows an explicit one', () => {
    const root = makeRoot()
    const out = '.cache/opencode/m5-M5-01.json'
    expect(run(['--role', 'M5', '--task', 'M5-01', '--model', TEST_MODEL, '--out', out], root).code).toBe(0)
    const second = run(['--role', 'M5', '--task', 'M5-01', '--model', TEST_MODEL, '--out', out], root)
    expect(second.code).toBe(1)
    expect(second.stderr).toContain('refusing to overwrite')
    const third = run(
      ['--role', 'M5', '--task', 'M5-01', '--model', TEST_MODEL, '--out', out, '--overwrite'],
      root,
    )
    expect(third.code).toBe(0)
  })

  it('refuses a symlinked output directory', () => {
    const root = makeRoot()
    const outside = mkdtempSync(join(tmpdir(), 'opencode-policy-outside-'))
    tempRoots.push(outside)
    mkdirSync(join(root, '.cache'), { recursive: true })
    symlinkSync(outside, join(root, '.cache/opencode'), 'dir')
    const result = run(
      ['--role', 'M5', '--task', 'M5-01', '--model', TEST_MODEL, '--out', '.cache/opencode/x.json'],
      root,
    )
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('symlink')
  })

  it('refuses a symlinked parent of the output directory', () => {
    const root = makeRoot()
    const outside = mkdtempSync(join(tmpdir(), 'opencode-policy-parent-'))
    tempRoots.push(outside)
    symlinkSync(outside, join(root, '.cache'), 'dir')
    const result = run(
      ['--role', 'M5', '--task', 'M5-01', '--model', TEST_MODEL, '--out', '.cache/opencode/x.json'],
      root,
    )
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('symlink')
    expect(existsSync(join(outside, 'opencode/x.json'))).toBe(false)
  })

  it('does not modify the policy source', () => {
    const root = makeRoot()
    const before = readFileSync(join(root, POLICY_PATH), 'utf8')
    expect(
      run(['--role', 'M5', '--task', 'M5-01', '--model', TEST_MODEL, '--out', '.cache/opencode/x.json'], root).code,
    ).toBe(0)
    expect(readFileSync(join(root, POLICY_PATH), 'utf8')).toBe(before)
  })

  it('prints a config to stdout when no output is requested', () => {
    const root = makeRoot()
    const result = run(['--role', 'M5', '--task', 'M5-01', '--model', OTHER_MODEL], root)
    expect(result.code).toBe(0)
    const parsed = JSON.parse(result.stdout) as {
      plugins?: string[]
      agents: Record<string, { model: string }>
    }
    expect(Object.prototype.hasOwnProperty.call(parsed, 'plugins')).toBe(false)
    expect(parsed.agents.build.model).toBe(OTHER_MODEL)
    expect(existsSync(join(root, '.cache'))).toBe(false)
  })

  it('turns a bare exclusion name into a leading-hyphen plugin and records the requested name', () => {
    const root = makeRoot()
    const out = '.cache/opencode/m5-M5-01.json'
    expect(
      run(
        ['--role', 'M5', '--task', 'M5-01', '--model', TEST_MODEL, '--exclude-plugin', PLUGIN_NAME, '--out', out],
        root,
      ).code,
    ).toBe(0)

    const config = JSON.parse(readFileSync(join(root, out), 'utf8')) as { plugins?: string[] }
    expect(config.plugins).toEqual([EXCLUDED_PLUGIN])
    expect(config.plugins).not.toContain(PLUGIN_NAME)

    const meta = JSON.parse(readFileSync(join(root, '.cache/opencode/m5-M5-01.meta.json'), 'utf8')) as {
      excludePlugins: string[]
    }
    expect(meta.excludePlugins).toEqual([PLUGIN_NAME])
  })

  it('records agent, model and plugin exclusions in the sidecar and rejects drift', () => {
    const root = makeRoot()
    const out = '.cache/opencode/m5-M5-01.json'
    const write = [
      '--role',
      'M5',
      '--task',
      'M5-01',
      '--agent',
      'reviewer',
      '--model',
      TEST_MODEL,
      '--exclude-plugin',
      PLUGIN_NAME,
      '--out',
      out,
    ]
    expect(run(write, root).code).toBe(0)

    const target = join(root, out)
    const config = JSON.parse(readFileSync(target, 'utf8')) as {
      plugins?: string[]
      agents: Record<string, { model: string }>
    }
    expect(Object.keys(config.agents)).toEqual(['reviewer'])
    expect(config.agents.reviewer.model).toBe(TEST_MODEL)
    expect(config.plugins).toEqual([EXCLUDED_PLUGIN])

    const meta = JSON.parse(readFileSync(join(root, '.cache/opencode/m5-M5-01.meta.json'), 'utf8')) as {
      agent: string
      model: string
      excludePlugins: string[]
    }
    expect(meta.agent).toBe('reviewer')
    expect(meta.model).toBe(TEST_MODEL)
    expect(meta.excludePlugins).toEqual([PLUGIN_NAME])

    const check = ['--role', 'M5', '--task', 'M5-01', '--check', out]
    const same = run(
      [...check, '--agent', 'reviewer', '--model', TEST_MODEL, '--exclude-plugin', PLUGIN_NAME],
      root,
    )
    expect(same.code).toBe(0)

    const agentDrift = run([...check, '--agent', 'build', '--model', TEST_MODEL, '--exclude-plugin', PLUGIN_NAME], root)
    expect(agentDrift.code).toBe(1)
    expect(agentDrift.stderr).toContain('drift:')

    const modelDrift = run(
      [...check, '--agent', 'reviewer', '--model', OTHER_MODEL, '--exclude-plugin', PLUGIN_NAME],
      root,
    )
    expect(modelDrift.code).toBe(1)
    expect(modelDrift.stderr).toContain('drift:')

    const pluginDrift = run([...check, '--agent', 'reviewer', '--model', TEST_MODEL], root)
    expect(pluginDrift.code).toBe(1)
    expect(pluginDrift.stderr).toContain('drift:')

    const otherPlugin = run(
      [...check, '--agent', 'reviewer', '--model', TEST_MODEL, '--exclude-plugin', 'other-plugin'],
      root,
    )
    expect(otherPlugin.code).toBe(1)
    expect(otherPlugin.stderr).toContain('drift:')
  })

  it('records approval grants in the sidecar and requires them on check', () => {
    const root = makeRoot()
    const out = '.cache/opencode/m5-M5-01.json'
    expect(
      run(
        ['--role', 'M5', '--task', 'M5-01', '--model', TEST_MODEL, '--approve', 'shared_contracts', '--out', out],
        root,
      ).code,
    ).toBe(0)
    const meta = JSON.parse(readFileSync(join(root, '.cache/opencode/m5-M5-01.meta.json'), 'utf8')) as {
      grants: string[]
    }
    expect(meta.grants).toEqual(['shared_contracts'])
    expect(run(['--role', 'M5', '--task', 'M5-01', '--model', TEST_MODEL, '--check', out], root).code).toBe(1)
    expect(
      run(
        [
          '--role',
          'M5',
          '--task',
          'M5-01',
          '--model',
          TEST_MODEL,
          '--approve',
          'shared_contracts',
          '--check',
          out,
        ],
        root,
      ).code,
    ).toBe(0)
  })

  it('rejects unknown flags, missing values and incompatible options', () => {
    const root = makeRoot()
    expect(run(['--role', 'M5', '--task', 'M5-01', '--model', TEST_MODEL, '--bogus'], root).code).toBe(1)
    expect(run(['--role', 'M5', '--model', TEST_MODEL], root).code).toBe(1)
    expect(
      run(
        ['--role', 'M5', '--task', 'M5-01', '--model', TEST_MODEL, '--out', 'x.json', '--check', 'x.json'],
        root,
      ).code,
    ).toBe(1)
    expect(run(['--role', 'M5', '--task', 'M5-01', '--model', TEST_MODEL, '--overwrite'], root).code).toBe(1)
    expect(run(['--role', 'M7', '--task', 'M5-01', '--model', TEST_MODEL], root).code).toBe(1)
    expect(
      run(['--role', 'M5', '--task', 'M5-01', '--model', TEST_MODEL, '--approve', 'bogus'], root).code,
    ).toBe(1)
    expect(
      run(['--role', 'M5', '--task', 'M5-01', '--model', TEST_MODEL, '--exclude-plugin'], root).code,
    ).toBe(1)
    expect(run(['--role', 'M5', '--task', 'M5-01', '--model'], root).code).toBe(1)
  })
})

describe('policy type surface', () => {
  it('keeps the parsed role record complete', () => {
    const roles: Policy['roles'] = POLICY.roles
    expect(roles.M1.source).toEqual(['src/performance/**'])
    expect(roles.M5.shell).toContain('pnpm test:m5')
  })
})
