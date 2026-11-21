import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { DIAGNOSTICS_PROTOCOL_VERSION, type DiagnosticReply } from '../../contracts'
import { Alert, Card, Empty, FactChip, Facts, Glyph, StateIcon } from '../design/ui'
import { SourceBars } from '../design/charts'

const HEALTH_PATH = '/health'
const DIAGNOSTICS_PATH = '/diag'
const PING_KIND = 'ping'

/**
 * Diagnostics protocol 1 panel. Every action is an icon button with a
 * hover tooltip — connect, ping (with live round-trip latency), memory
 * inspect (charts the numeric telemetry the runtime reports) and close.
 * The panel never touches session, input, control or playback state.
 */

interface HealthView {
  service: string
  version: string
  role: string
  loopbackOnly: boolean
  diagnosticsVersion: number
  applicationVersion: number | null
  capabilities: string[]
  uptimeSec: number
}

type SocketState = 'connecting' | 'open' | 'closed' | 'error'

interface Metric {
  key: string
  value: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseHealth(value: unknown): HealthView | null {
  if (!isRecord(value) || value.ok !== true) return null
  if (typeof value.service !== 'string' || typeof value.version !== 'string') return null
  if (typeof value.role !== 'string' || typeof value.loopbackOnly !== 'boolean') return null
  if (typeof value.uptimeSec !== 'number' || !isRecord(value.protocol)) return null
  const diagnosticsVersion = value.protocol.diagnostics
  const applicationVersion = value.protocol.application
  if (typeof diagnosticsVersion !== 'number') return null
  if (applicationVersion !== null && typeof applicationVersion !== 'number') return null
  if (!Array.isArray(value.capabilities) || !value.capabilities.every((entry) => typeof entry === 'string')) {
    return null
  }
  return {
    service: value.service,
    version: value.version,
    role: value.role,
    loopbackOnly: value.loopbackOnly,
    diagnosticsVersion,
    applicationVersion,
    capabilities: value.capabilities,
    uptimeSec: value.uptimeSec,
  }
}

function parseReply(value: unknown): DiagnosticReply | null {
  if (!isRecord(value)) return null
  if (value.v !== DIAGNOSTICS_PROTOCOL_VERSION) return null
  if (typeof value.ok !== 'boolean' || typeof value.kind !== 'string') return null
  if (value.ok === false && (!isRecord(value.error) || typeof value.error.code !== 'string')) {
    return null
  }
  return value as unknown as DiagnosticReply
}

/** Walk a reply and collect its numeric leaves for the telemetry chart. */
function collectNumbers(value: unknown, prefix: string, out: Metric[]): void {
  if (out.length >= 8) return
  if (typeof value === 'number' && Number.isFinite(value)) {
    out.push({ key: prefix, value })
    return
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectNumbers(entry, `${prefix}[${index}]`, out))
    return
  }
  if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) {
      collectNumbers(entry, prefix === '' ? key : `${prefix}.${key}`, out)
    }
  }
}


export function DiagnosticsPage() {
  const [health, setHealth] = useState<HealthView | null>(null)
  const [healthError, setHealthError] = useState<string | null>(null)
  const [healthLoading, setHealthLoading] = useState(true)
  const [socketState, setSocketState] = useState<SocketState>('connecting')
  const [socketError, setSocketError] = useState<string | null>(null)
  const [lastReply, setLastReply] = useState<string | null>(null)
  const [latencyMs, setLatencyMs] = useState<number | null>(null)
  const [metrics, setMetrics] = useState<readonly Metric[] | null>(null)

  const socketRef = useRef<WebSocket | null>(null)
  const healthAbortRef = useRef<AbortController | null>(null)
  const activeRef = useRef(true)
  const pingSentAtRef = useRef<number | null>(null)

  const refreshHealth = useCallback(async () => {
    healthAbortRef.current?.abort()
    const controller = new AbortController()
    healthAbortRef.current = controller
    const isCurrent = (): boolean =>
      activeRef.current && !controller.signal.aborted && healthAbortRef.current === controller
    try {
      const response = await fetch(HEALTH_PATH, {
        signal: controller.signal,
        headers: { accept: 'application/json' },
      })
      if (!response.ok) throw new Error(`health request failed with status ${response.status}`)
      const parsed = parseHealth(await response.json())
      if (parsed === null) throw new Error('health response failed validation')
      if (!isCurrent()) return
      setHealth(parsed)
      setHealthError(null)
    } catch (error) {
      if (!isCurrent()) return
      setHealth(null)
      setHealthError(error instanceof Error ? error.message : String(error))
    } finally {
      if (isCurrent()) setHealthLoading(false)
    }
  }, [])

  const startSocket = useCallback(() => {
    if (socketRef.current !== null) return
    const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const socket = new WebSocket(`${scheme}://${window.location.host}${DIAGNOSTICS_PATH}`)
    socketRef.current = socket
    socket.onopen = () => {
      setSocketState('open')
      setSocketError(null)
    }
    socket.onclose = (event) => {
      setSocketState('closed')
      socketRef.current = null
      healthAbortRef.current?.abort()
      setHealth(null)
      setHealthLoading(false)
      setHealthError('backend health cleared because the diagnostics socket closed')
      if (!event.wasClean) {
        setSocketError(`diagnostics socket closed unexpectedly (code ${event.code})`)
      }
    }
    socket.onerror = () => {
      setSocketState('error')
      setSocketError('diagnostics socket error')
      healthAbortRef.current?.abort()
      setHealth(null)
      setHealthLoading(false)
      setHealthError('backend health cleared because the diagnostics socket errored')
    }
    socket.onmessage = (event) => {
      try {
        const parsed = parseReply(JSON.parse(String(event.data)))
        if (parsed !== null && pingSentAtRef.current !== null) {
          setLatencyMs(Math.max(1, Math.round(performance.now() - pingSentAtRef.current)))
          pingSentAtRef.current = null
        }
        setLastReply(parsed === null ? 'Unrecognised reply from diagnostics server' : JSON.stringify(parsed, null, 2))
        if (parsed !== null && isRecord(parsed)) {
          const metrics: Metric[] = []
          collectNumbers(parsed, '', metrics)
          setMetrics(metrics.length > 0 ? metrics : null)
        }
      } catch {
        setLastReply('Unrecognised reply from diagnostics server')
      }
    }
  }, [])

  const closeSocket = useCallback(() => {
    const socket = socketRef.current
    if (socket === null) return
    socket.close(1000, 'console requested close')
  }, [])

  useEffect(() => {
    activeRef.current = true
    const initialFetchTimer = setTimeout(() => {
      void refreshHealth()
    }, 0)
    return () => {
      activeRef.current = false
      clearTimeout(initialFetchTimer)
      healthAbortRef.current?.abort()
      const socket = socketRef.current
      socketRef.current = null
      if (socket !== null) {
        socket.onopen = null
        socket.onclose = null
        socket.onerror = null
        socket.onmessage = null
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
          socket.close(1000, 'console unmounting')
        }
      }
    }
  }, [refreshHealth])

  const sendKind = useCallback((kind: string): void => {
    const socket = socketRef.current
    if (socket === null || socket.readyState !== WebSocket.OPEN) return
    if (kind === PING_KIND) pingSentAtRef.current = performance.now()
    socket.send(JSON.stringify({ v: DIAGNOSTICS_PROTOCOL_VERSION, id: `console-${Date.now()}`, kind }))
  }, [])

  const healthRows: readonly (readonly [string, ReactNode])[] =
    health === null
      ? []
      : [
          ['Service', <FactChip key="svc" value={health.service} />],
          ['Version', <FactChip key="ver" value={health.version} />],
          ['Role', <FactChip key="role" value={health.role} />],
          ['Loopback only', <FactChip key="loop" value={health.loopbackOnly ? 'yes' : 'no'} />],
          ['Diagnostics protocol', <FactChip key="dp" value={String(health.diagnosticsVersion)} />],
          ['Application protocol', <FactChip key="ap" value={health.applicationVersion === null ? 'not implemented' : String(health.applicationVersion)} />],
          ['Capabilities', <FactChip key="caps" value={health.capabilities.join(', ')} />],
          ['Uptime', <FactChip key="up" value={`${health.uptimeSec.toFixed(1)} s`} />],
        ]

  return (
    <div className="console__stack">
      <Card
        title="Diagnostics Backend Health"
        icon="pulse"
        tone="sky"
        className="isla-rise"
        collapsible
        defaultOpen={false}
      >
        <div className="console__actions">
          <button
            type="button"
            className={`diag-btn ${health !== null ? 'is-on' : ''}`.trim()}
            aria-label="Refresh backend health"
            data-tip="Refresh backend health"
            disabled={healthLoading}
            onClick={() => {
              setHealthLoading(true)
              setHealthError(null)
              void refreshHealth()
            }}
          >
            <Glyph name="pulse" size={16} />
          </button>
        </div>
        {healthError !== null && <Alert>{healthError}</Alert>}
        {health !== null && <Facts rows={healthRows} />}
        {health === null && healthError === null && <Empty>Waiting for the first health reply…</Empty>}
      </Card>

      <Card
        title="Diagnostics socket"
        icon="dish"
        tone="purple"
        className="isla-rise"
        collapsible
        defaultOpen={false}
      >
        <div className="console__actions">
          <button
            type="button"
            className={`diag-btn ${socketState === 'open' ? 'is-on' : ''}`.trim()}
            aria-label="Connect diagnostics socket"
            data-tip="Connect the /diag socket"
            disabled={socketState === 'open'}
            onClick={startSocket}
          >
            <Glyph name="plug" size={16} />
          </button>
          <button
            type="button"
            className="diag-btn"
            aria-label="Send diagnostics ping"
            data-tip="Send a ping and measure the round trip"
            disabled={socketState !== 'open'}
            onClick={() => sendKind(PING_KIND)}
          >
            <Glyph name="pulse" size={16} />
          </button>
          <button
            type="button"
            className="diag-btn"
            aria-label="Request memory inspect"
            data-tip="Request memory telemetry and chart it"
            disabled={socketState !== 'open'}
            onClick={() => sendKind('get_memory_inspect')}
          >
            <Glyph name="chart" size={16} />
          </button>
          <button
            type="button"
            className="diag-btn"
            aria-label="Close diagnostics socket"
            data-tip="Close the diagnostics socket"
            disabled={socketState !== 'open'}
            onClick={closeSocket}
          >
            <Glyph name="cross" size={16} />
          </button>
          <span className="diag-latency" title="Last ping round trip">
            <StateIcon ok={latencyMs !== null} plain={latencyMs === null} />
            {latencyMs === null ? 'No ping yet' : `${latencyMs} ms`}
          </span>
        </div>
        {socketError !== null && <Alert>{socketError}</Alert>}
        {metrics !== null && (
          <>
            <h3 className="chart-cell__head">Memory telemetry</h3>
            <SourceBars entries={metrics.map((metric) => ({ label: metric.key, count: metric.value }))} />
          </>
        )}
        {lastReply !== null ? (
          <details className="diag-reply">
            <summary className="diag-reply__summary">Last reply</summary>
            <pre className="isla-code">{lastReply}</pre>
          </details>
        ) : (
          <Empty>No diagnostics reply yet.</Empty>
        )}
      </Card>
    </div>
  )
}
