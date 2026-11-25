import { createHash } from 'node:crypto'
import { existsSync, lstatSync } from 'node:fs'
import { isAbsolute, join, resolve, sep } from 'node:path'

/**
 * Task-local OpenCode policy compiler.
 *
 * The policy source is `.opencode/permissions.jsonc`. It is a policy document,
 * not an automatically loaded OpenCode configuration. `compileConfig` derives a
 * single ordinary JSON configuration for one role and one task; whether that
 * file is the effective layer is a native property of the target worktree and is
 * not established here.
 *
 * Plugin exclusion follows the observed OpenCode V2 form: an excluded plugin is
 * listed as `"-<name>"`, with a leading hyphen. A bare name requests the plugin
 * instead of excluding it, so `compileConfig` adds the hyphen to every supplied
 * exclusion name while the sidecar keeps the name the caller supplied.
 *
 * The evaluator in this module is a test helper over our own simplified glob
 * semantics. It is not a simulation of the OpenCode permission matcher.
 */

export const POLICY_PATH = '.opencode/permissions.jsonc'

/**
 * Default agent name. The agent key and the model are supplied per invocation;
 * the policy source does not commit a provider, model or plugin name.
 */
export const DEFAULT_AGENT = 'build'

export const OUTPUT_BASE = '.cache/opencode'

export const ROLE_IDS = ['M1', 'M2', 'M3', 'M4', 'M5', 'M6'] as const

export type RoleId = (typeof ROLE_IDS)[number]

export const APPROVAL_CLASSES = [
  'shared_contracts',
  'manifests',
  'frozen',
  'governance',
  'other_modules',
] as const

export type ApprovalClass = (typeof APPROVAL_CLASSES)[number]

export type Effect = 'allow' | 'deny'

export interface PermissionRule {
  action: string
  resource: string
  effect: Effect
}

export interface RolePolicy {
  source: string[]
  tests: string[]
  handoffs: string[]
  shell: string[]
}

export interface Policy {
  version: 1
  status: 'under-review'
  description: string
  defaultEffect: 'deny'
  read: string[]
  roles: Record<RoleId, RolePolicy>
  approvals: Record<ApprovalClass, string[]>
  protectedPaths: string[]
  hardDeny: {
    credentials: string[]
    actions: string[]
    shell: string[]
  }
  shell: {
    common: string[]
  }
}

export interface AgentConfig {
  disabled: false
  model: string
  permissions: PermissionRule[]
}

export interface BuildConfig {
  /** Exclusions in the V2 leading-hyphen form: `"-<name>"`. */
  plugins?: string[]
  agents: Record<string, AgentConfig>
}

/** Values supplied by the caller; the policy source commits none of them. */
export interface ConfigRuntime {
  agent: string
  model: string
  /** Bare plugin exclusion names; `compileConfig` emits the hyphen form. */
  excludePlugins: string[]
}

export interface ConfigMeta {
  policy: string
  policySha256: string
  configSha256: string
  role: RoleId
  task: string
  grants: ApprovalClass[]
  status: 'under-review'
  agent: string
  model: string
  excludePlugins: string[]
  note: string
}

/**
 * These patterns are mandatory. A policy that removes one is rejected, so a
 * later edit cannot silently weaken the credential boundary.
 */
export const REQUIRED_CREDENTIAL_PATTERNS = [
  '.env',
  '.env.*',
  '**/.env',
  '**/.env.*',
  '**/*.env',
  '**/*secret*',
  '**/*token*',
  '**/*password*',
  '**/*credential*',
  '**/*auth.*',
  '**/.auth*',
  '**/auth/**',
  'id_*',
  '**/id_*',
  '**/*.pem',
  '**/*.p12',
  '**/*.key',
  '**/.ssh/**',
  '**/.aws/**',
  '**/.gnupg/**',
] as const

const TOP_LEVEL_KEYS = [
  'version',
  'status',
  'description',
  'defaultEffect',
  'read',
  'roles',
  'approvals',
  'protectedPaths',
  'hardDeny',
  'shell',
] as const

function fail(message: string): never {
  throw new Error(`policy: ${message}`)
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(`${label} must be a non-empty string`)
  }
  return value
}

function requireStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) {
    fail(`${label} must be an array of strings`)
  }
  const items: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || item.trim().length === 0) {
      fail(`${label} must contain only non-empty strings`)
    }
    items.push(item)
  }
  if (new Set(items).size !== items.length) {
    fail(`${label} must not contain duplicates`)
  }
  return items
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${label} must have exactly the keys: ${wanted.join(', ')}`)
  }
}

function parseRole(value: unknown, label: string): RolePolicy {
  const record = asRecord(value, label)
  assertExactKeys(record, ['source', 'tests', 'handoffs', 'shell'], label)
  const source = requireStringArray(record.source, `${label}.source`)
  const tests = requireStringArray(record.tests, `${label}.tests`)
  if (source.length === 0) fail(`${label}.source must not be empty`)
  if (tests.length === 0) fail(`${label}.tests must not be empty`)
  return {
    source,
    tests,
    handoffs: requireStringArray(record.handoffs, `${label}.handoffs`),
    shell: requireStringArray(record.shell, `${label}.shell`),
  }
}

export function parsePolicy(text: string): Policy {
  let parsed: unknown = undefined
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    fail(`not valid JSON: ${reason}`)
  }
  const record = asRecord(parsed, 'policy')
  assertExactKeys(record, TOP_LEVEL_KEYS, 'policy')

  if (record.version !== 1) fail('version must be 1')
  if (record.status !== 'under-review') fail('status must be "under-review"')
  if (record.defaultEffect !== 'deny') fail('defaultEffect must be "deny"')

  const rolesRecord = asRecord(record.roles, 'roles')
  assertExactKeys(rolesRecord, ROLE_IDS, 'roles')
  const roles = {} as Record<RoleId, RolePolicy>
  for (const role of ROLE_IDS) {
    roles[role] = parseRole(rolesRecord[role], `roles.${role}`)
  }

  const approvalsRecord = asRecord(record.approvals, 'approvals')
  assertExactKeys(approvalsRecord, APPROVAL_CLASSES, 'approvals')
  const approvals = {} as Record<ApprovalClass, string[]>
  for (const approval of APPROVAL_CLASSES) {
    approvals[approval] = requireStringArray(approvalsRecord[approval], `approvals.${approval}`)
  }

  const hardDenyRecord = asRecord(record.hardDeny, 'hardDeny')
  assertExactKeys(hardDenyRecord, ['credentials', 'actions', 'shell'], 'hardDeny')
  const credentials = requireStringArray(hardDenyRecord.credentials, 'hardDeny.credentials')
  for (const pattern of REQUIRED_CREDENTIAL_PATTERNS) {
    if (!credentials.includes(pattern)) {
      fail(`hardDeny.credentials must include "${pattern}"`)
    }
  }
  const actions = requireStringArray(hardDenyRecord.actions, 'hardDeny.actions')
  if (!actions.includes('task')) fail('hardDeny.actions must include "task"')

  const shellRecord = asRecord(record.shell, 'shell')
  assertExactKeys(shellRecord, ['common'], 'shell')

  return {
    version: 1,
    status: 'under-review',
    description: requireString(record.description, 'description'),
    defaultEffect: 'deny',
    read: requireStringArray(record.read, 'read'),
    roles,
    approvals,
    protectedPaths: requireStringArray(record.protectedPaths, 'protectedPaths'),
    hardDeny: {
      credentials,
      actions,
      shell: requireStringArray(hardDenyRecord.shell, 'hardDeny.shell'),
    },
    shell: {
      common: requireStringArray(shellRecord.common, 'shell.common'),
    },
  }
}

function expandPattern(pattern: string, root: string): string[] {
  const normalized = pattern.replaceAll('\\', '/')
  if (isAbsolute(normalized)) return [normalized]
  const absoluteRoot = root.replaceAll('\\', '/').replace(/\/+$/, '')
  return [normalized, `${absoluteRoot}/${normalized}`]
}

function addRules(
  rules: PermissionRule[],
  actions: readonly string[],
  patterns: readonly string[],
  root: string,
  effect: Effect,
): void {
  for (const pattern of patterns) {
    for (const resource of expandPattern(pattern, root)) {
      for (const action of actions) {
        rules.push({ action, resource, effect })
      }
    }
  }
}

function normalizeRuntime(runtime: ConfigRuntime): ConfigRuntime {
  return {
    agent: requireString(runtime.agent, 'agent'),
    model: requireString(runtime.model, 'model'),
    excludePlugins: requireStringArray(runtime.excludePlugins, 'excludePlugins'),
  }
}

export function compileConfig(
  policy: Policy,
  role: RoleId,
  grants: readonly ApprovalClass[],
  root: string,
  runtime: ConfigRuntime,
): BuildConfig {
  if (!(ROLE_IDS as readonly string[]).includes(role)) {
    fail(`unknown role "${String(role)}"`)
  }
  const { agent, model, excludePlugins } = normalizeRuntime(runtime)
  const granted = new Set<ApprovalClass>()
  for (const grant of grants) {
    if (!(APPROVAL_CLASSES as readonly string[]).includes(grant)) {
      fail(`unknown approval class "${String(grant)}"`)
    }
    granted.add(grant)
  }

  const rolePolicy = policy.roles[role]
  const rules: PermissionRule[] = []

  // Default deny. Every later allow must be more specific than this rule.
  rules.push({ action: '*', resource: '*', effect: 'deny' })

  // Reads are broad inside the checkout so callers can be traced before an API
  // changes. Writes are the narrow, role-owned surface below.
  addRules(rules, ['read', 'glob', 'grep'], policy.read, root, 'allow')

  // Role-owned source, tests and handoffs. The AI-use log is shared but every
  // change appends to it; path policy cannot enforce append-only.
  const ownPaths = [...rolePolicy.source, ...rolePolicy.tests, ...rolePolicy.handoffs, 'docs/ai-use-log.yaml']
  addRules(rules, ['edit', 'write'], ownPaths, root, 'allow')

  // Shell commands are exact strings. This does not promise that the native
  // matcher compares the whole command; verification is native.
  for (const command of [...policy.shell.common, ...rolePolicy.shell]) {
    rules.push({ action: 'shell', resource: command, effect: 'allow' })
  }

  // Explicit approval grants. These are write-only: reads are already allowed.
  for (const approval of APPROVAL_CLASSES) {
    if (granted.has(approval)) {
      addRules(rules, ['edit', 'write'], policy.approvals[approval], root, 'allow')
    }
  }

  // Frozen paths are a distinct approval. A shared-contract grant must not
  // silently open a frozen file, so an ungranted frozen class is denied after
  // the grant rules.
  if (!granted.has('frozen')) {
    addRules(rules, ['edit', 'write'], policy.approvals.frozen, root, 'deny')
  }

  // Hard denies come last. The credential list is narrow: it refuses actual
  // secret files and directories but keeps ordinary source names such as
  // src/dialogue/delivery-key.ts readable.
  addRules(rules, ['*'], policy.hardDeny.credentials, root, 'deny')
  addRules(rules, ['edit', 'write'], policy.protectedPaths, root, 'deny')
  for (const action of policy.hardDeny.actions) {
    rules.push({ action, resource: '*', effect: 'deny' })
  }
  for (const pattern of policy.hardDeny.shell) {
    rules.push({ action: 'shell', resource: pattern, effect: 'deny' })
  }

  const config: BuildConfig = {
    agents: {
      [agent]: {
        disabled: false,
        model,
        permissions: rules,
      },
    },
  }
  if (excludePlugins.length > 0) {
    // V2 excludes a plugin with a leading hyphen; a bare name would request it.
    // An already-prefixed name is kept as supplied so repeated runs are stable.
    config.plugins = excludePlugins.map((name) => (name.startsWith('-') ? name : `-${name}`))
  }
  return config
}

export function serializeConfig(config: BuildConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`
}

export function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

export function createMeta(
  policyText: string,
  configText: string,
  role: RoleId,
  task: string,
  grants: readonly ApprovalClass[],
  runtime: ConfigRuntime,
): ConfigMeta {
  const { agent, model, excludePlugins } = normalizeRuntime(runtime)
  return {
    policy: POLICY_PATH,
    policySha256: hashText(policyText),
    configSha256: hashText(configText),
    role,
    task,
    grants: [...new Set(grants)].sort(),
    status: 'under-review',
    agent,
    model,
    excludePlugins,
    note: 'Task-local configuration. Not proof of native enforcement; verify in a fresh worktree.',
  }
}

export function serializeMeta(meta: ConfigMeta): string {
  return `${JSON.stringify(meta, null, 2)}\n`
}

function escapeRegExpChar(char: string): string {
  return /[\\^$.*+?()[\]{}|]/.test(char) ? `\\${char}` : char
}

export function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replaceAll('\\', '/')
  let source = '^'
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index]
    if (char === '*') {
      if (normalized[index + 1] === '*') {
        if (normalized[index + 2] === '/') {
          source += '(?:.*/)?'
          index += 2
        } else {
          source += '.*'
          index += 1
        }
      } else {
        source += '[^/]*'
      }
    } else if (char === '?') {
      source += '[^/]'
    } else {
      source += escapeRegExpChar(char)
    }
  }
  return new RegExp(`${source}$`)
}

export function globMatch(pattern: string, value: string): boolean {
  return globToRegExp(pattern).test(value.replaceAll('\\', '/'))
}

/**
 * Test-only evaluator over the compiled rule list. It models last-match-wins
 * with the simplified glob above; it does not prove native OpenCode behaviour.
 */
export function evaluateRules(
  rules: readonly PermissionRule[],
  action: string,
  resource: string,
): Effect {
  let effect: Effect = 'deny'
  for (const rule of rules) {
    if ((rule.action === '*' || rule.action === action) && globMatch(rule.resource, resource)) {
      effect = rule.effect
    }
  }
  return effect
}

export function resolveOutputPath(root: string, raw: string): string {
  if (raw.trim().length === 0) fail('output path is empty')
  if (isAbsolute(raw)) fail('output path must be relative to the repository root')
  if (raw.split(/[\\/]/).includes('..')) fail('output path must not contain ".."')
  const base = resolve(root, OUTPUT_BASE)
  const target = resolve(root, raw)
  if (target === base || !target.startsWith(`${base}${sep}`)) {
    fail(`output path must stay inside ${OUTPUT_BASE}`)
  }
  return target
}

export function metaPathFor(target: string): string {
  return target.endsWith('.json') ? `${target.slice(0, -5)}.meta.json` : `${target}.meta.json`
}

function assertNotSymlink(path: string): void {
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    fail(`refusing symlink at ${path}`)
  }
}

export function assertNoSymlink(root: string, target: string): void {
  const normalizedRoot = resolve(root)
  const normalizedTarget = resolve(target)
  if (normalizedTarget !== normalizedRoot && !normalizedTarget.startsWith(`${normalizedRoot}${sep}`)) {
    fail(`path ${target} is outside ${normalizedRoot}`)
  }
  // Check every component below the repository root, including `.cache`, so a
  // symlinked parent directory cannot redirect generated output.
  const parts = normalizedTarget.slice(normalizedRoot.length + 1).split(sep).filter((part) => part.length > 0)
  let current = normalizedRoot
  for (const part of parts) {
    current = join(current, part)
    assertNotSymlink(current)
  }
}
