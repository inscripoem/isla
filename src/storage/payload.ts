/**
 * M6 storage — event payload contract (INV-04; ADR-002 D1).
 *
 * An event `payload` is `Record<string, unknown>`. Because the durable store
 * persists it as JSON, the supported domain is deliberately narrowed to **JSON
 * values**: anything JSON cannot represent faithfully is rejected before
 * publication rather than silently altered. This makes "same content"
 * well-defined and keeps the in-memory and SQLite backends in agreement (a
 * sparse array, for example, would otherwise survive in memory but become `null`
 * on disk).
 *
 * Supported: `null` · boolean · finite number · string · arrays with no holes ·
 * plain objects with string keys.
 * Rejected: `undefined` · function · symbol · bigint · non-finite number ·
 * sparse-array holes · `Date`/`Map`/`Set`/class instances · cycles.
 */

const OBJECT_PROTOTYPE = Object.prototype

function isPlainRecord(value: object): boolean {
  const prototype = Object.getPrototypeOf(value)
  return prototype === OBJECT_PROTOTYPE || prototype === null
}

/**
 * Returns `null` when `value` is a JSON value, otherwise a short reason naming
 * the first problem found (used in the rejection acknowledgement).
 */
export function jsonValueIssue(
  value: unknown,
  seen: WeakSet<object> = new WeakSet(),
): string | null {
  if (value === null) return null
  switch (typeof value) {
    case 'boolean':
    case 'string':
      return null
    case 'number':
      return Number.isFinite(value) ? null : 'non-finite number'
    case 'undefined':
      return 'undefined'
    case 'function':
      return 'function'
    case 'symbol':
      return 'symbol'
    case 'bigint':
      return 'bigint'
    case 'object':
      break
    default:
      return `unsupported type ${typeof value}`
  }

  const object = value as object
  if (seen.has(object)) return 'cycle'
  seen.add(object)
  try {
    if (Array.isArray(object)) {
      for (let index = 0; index < object.length; index += 1) {
        // `index in object` is false for holes in a sparse array; JSON would
        // render a hole as `null`, which is a different value.
        if (!(index in object)) return `sparse array (hole at index ${index})`
        const issue = jsonValueIssue(object[index], seen)
        if (issue !== null) return `array element ${index}: ${issue}`
      }
      return null
    }
    if (!isPlainRecord(object)) {
      return `non-plain object (${Object.prototype.toString.call(object)})`
    }
    for (const key of Object.keys(object as Record<string, unknown>)) {
      const issue = jsonValueIssue((object as Record<string, unknown>)[key], seen)
      if (issue !== null) return `key "${key}": ${issue}`
    }
    return null
  } finally {
    seen.delete(object)
  }
}

/**
 * Canonical, key-order-insensitive rendering of a **JSON value**. Deterministic
 * for equal content; array order is significant. Only valid for values that
 * passed `jsonValueIssue` (it still renders sparse holes distinctly, so it can
 * never conflate them).
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) {
    const parts: string[] = []
    for (let index = 0; index < value.length; index += 1) parts.push(canonicalJson(value[index]))
    return `[${parts.join(',')}]`
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    const parts = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    return `{${parts.join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}
