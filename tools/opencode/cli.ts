import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  APPROVAL_CLASSES,
  DEFAULT_AGENT,
  POLICY_PATH,
  ROLE_IDS,
  assertNoSymlink,
  compileConfig,
  createMeta,
  hashText,
  metaPathFor,
  parsePolicy,
  resolveOutputPath,
  serializeConfig,
  serializeMeta,
} from './policy.ts'
import type { ApprovalClass, ConfigMeta, ConfigRuntime, RoleId } from './policy.ts'

export interface CliIo {
  cwd: string
  stdout: (text: string) => void
  stderr: (text: string) => void
}

interface ParsedArgs {
  role: string
  task: string
  grants: string[]
  agent: string
  model: string
  excludePlugins: string[]
  out?: string
  check?: string
  overwrite: boolean
}

/**
 * `--exclude-plugin` takes a bare plugin name. The emitted configuration writes
 * the V2 exclusion form `"-<name>"`; the sidecar records the name as supplied.
 */
function parseArgs(argv: readonly string[]): ParsedArgs {
  let role: string | undefined
  let task: string | undefined
  let agent = DEFAULT_AGENT
  let model: string | undefined
  let out: string | undefined
  let check: string | undefined
  let overwrite = false
  const grants: string[] = []
  const excludePlugins: string[] = []

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const readValue = (): string => {
      const next = argv[index + 1]
      if (next === undefined) throw new Error(`missing value for ${arg}`)
      index += 1
      return next
    }
    if (arg === '--role') {
      role = readValue()
    } else if (arg === '--task') {
      task = readValue()
    } else if (arg === '--agent') {
      agent = readValue()
    } else if (arg === '--model') {
      model = readValue()
    } else if (arg === '--exclude-plugin') {
      excludePlugins.push(readValue())
    } else if (arg === '--approve') {
      grants.push(
        ...readValue()
          .split(',')
          .map((value) => value.trim())
          .filter((value) => value.length > 0),
      )
    } else if (arg === '--out') {
      out = readValue()
    } else if (arg === '--check') {
      check = readValue()
    } else if (arg === '--overwrite') {
      overwrite = true
    } else {
      throw new Error(`unknown argument "${arg}"`)
    }
  }

  if (role === undefined) throw new Error('--role is required')
  if (task === undefined) throw new Error('--task is required')
  if (model === undefined) throw new Error('--model is required')
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(task)) {
    throw new Error('--task must be a short label of letters, digits, dot, underscore or hyphen')
  }
  if (out !== undefined && check !== undefined) throw new Error('--out and --check are mutually exclusive')
  if (overwrite && out === undefined) throw new Error('--overwrite requires --out')
  return { role, task, grants, agent, model, excludePlugins: [...new Set(excludePlugins)].sort(), out, check, overwrite }
}

function asRole(value: string): RoleId {
  if (!(ROLE_IDS as readonly string[]).includes(value)) {
    throw new Error(`unknown role "${value}"; expected one of ${ROLE_IDS.join(', ')}`)
  }
  return value as RoleId
}

function asGrants(values: readonly string[]): ApprovalClass[] {
  const grants: ApprovalClass[] = []
  for (const value of values) {
    if (!(APPROVAL_CLASSES as readonly string[]).includes(value)) {
      throw new Error(`unknown approval class "${value}"; expected one of ${APPROVAL_CLASSES.join(', ')}`)
    }
    grants.push(value as ApprovalClass)
  }
  return grants
}

function parseMeta(text: string): ConfigMeta {
  const value: unknown = JSON.parse(text)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('sidecar is not an object')
  }
  const record = value as Record<string, unknown>
  if (
    typeof record.configSha256 !== 'string' ||
    typeof record.policySha256 !== 'string' ||
    typeof record.role !== 'string' ||
    typeof record.task !== 'string' ||
    typeof record.agent !== 'string' ||
    typeof record.model !== 'string' ||
    !Array.isArray(record.grants) ||
    !Array.isArray(record.excludePlugins)
  ) {
    throw new Error('sidecar is malformed')
  }
  if (
    !record.grants.every((grant) => typeof grant === 'string') ||
    !record.excludePlugins.every((plugin) => typeof plugin === 'string')
  ) {
    throw new Error('sidecar is malformed')
  }
  return value as ConfigMeta
}

function writePair(
  root: string,
  target: string,
  metaPath: string,
  configText: string,
  metaText: string,
  overwrite: boolean,
): void {
  assertNoSymlink(root, target)
  assertNoSymlink(root, metaPath)

  if (!overwrite && (existsSync(target) || existsSync(metaPath))) {
    const existing = existsSync(target) ? target : metaPath
    throw new Error(`refusing to overwrite ${existing}; pass --overwrite to replace both files`)
  }

  mkdirSync(dirname(target), { recursive: true })
  assertNoSymlink(root, target)
  assertNoSymlink(root, metaPath)

  const token = randomBytes(6).toString('hex')
  const configTemp = `${target}.tmp-${token}`
  const metaTemp = `${metaPath}.tmp-${token}`
  let renamedConfig = false
  try {
    writeFileSync(configTemp, configText, { encoding: 'utf8', flag: 'wx' })
    writeFileSync(metaTemp, metaText, { encoding: 'utf8', flag: 'wx' })
    renameSync(configTemp, target)
    renamedConfig = true
    renameSync(metaTemp, metaPath)
  } catch (error) {
    for (const path of [configTemp, metaTemp]) {
      try {
        if (existsSync(path)) rmSync(path, { force: true })
      } catch {
        // Best-effort cleanup; the original error is more useful.
      }
    }
    if (renamedConfig && !overwrite) {
      try {
        if (existsSync(target)) rmSync(target, { force: true })
      } catch {
        // Best-effort cleanup; the original error is more useful.
      }
    }
    throw error
  }
}

export function runCli(argv: readonly string[], io: CliIo): number {
  try {
    const parsed = parseArgs(argv)
    const role = asRole(parsed.role)
    const grants = asGrants(parsed.grants)
    const root = resolve(io.cwd)

    const policyText = readFileSync(join(root, POLICY_PATH), 'utf8')
    const policy = parsePolicy(policyText)
    const runtime: ConfigRuntime = {
      agent: parsed.agent,
      model: parsed.model,
      excludePlugins: parsed.excludePlugins,
    }
    const config = compileConfig(policy, role, grants, root, runtime)
    const configText = serializeConfig(config)

    if (parsed.check !== undefined) {
      const target = resolveOutputPath(root, parsed.check)
      assertNoSymlink(root, target)
      const actual = readFileSync(target, 'utf8')
      if (actual !== configText) {
        throw new Error(`drift: ${target} does not match the current policy, role, task and grants`)
      }
      const metaPath = metaPathFor(target)
      assertNoSymlink(root, metaPath)
      const meta = parseMeta(readFileSync(metaPath, 'utf8'))
      if (meta.configSha256 !== hashText(actual)) {
        throw new Error('drift: sidecar config hash does not match the generated file')
      }
      if (meta.policySha256 !== hashText(policyText)) {
        throw new Error('drift: sidecar policy hash does not match the current policy')
      }
      if (meta.role !== role || meta.task !== parsed.task) {
        throw new Error('drift: sidecar role or task does not match this invocation')
      }
      const expectedGrants = [...new Set(grants)].sort()
      if (JSON.stringify(meta.grants) !== JSON.stringify(expectedGrants)) {
        throw new Error('drift: sidecar grants do not match this invocation')
      }
      if (meta.agent !== runtime.agent || meta.model !== runtime.model) {
        throw new Error('drift: sidecar agent or model does not match this invocation')
      }
      if (JSON.stringify(meta.excludePlugins) !== JSON.stringify(runtime.excludePlugins)) {
        throw new Error('drift: sidecar plugin exclusions do not match this invocation')
      }
      io.stdout(`ok ${target}\n`)
      return 0
    }

    if (parsed.out !== undefined) {
      const target = resolveOutputPath(root, parsed.out)
      const metaPath = metaPathFor(target)
      const metaText = serializeMeta(createMeta(policyText, configText, role, parsed.task, grants, runtime))
      writePair(root, target, metaPath, configText, metaText, parsed.overwrite)
      io.stdout(`wrote ${target}\nwrote ${metaPath}\n`)
      return 0
    }

    io.stdout(configText)
    return 0
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    io.stderr(`error: ${reason}\n`)
    return 1
  }
}

const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  process.exitCode = runCli(process.argv.slice(2), {
    cwd: process.cwd(),
    stdout: (text) => {
      process.stdout.write(text)
    },
    stderr: (text) => {
      process.stderr.write(text)
    },
  })
}
