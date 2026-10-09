import { useCallback, useEffect, useRef, useState } from 'react'
import { DIAGNOSTICS_PROTOCOL_VERSION, type DiagnosticReply } from '../contracts'
import './console.css'

const HEALTH_PATH = '/health'
const DIAGNOSTICS_PATH = '/diag'
const PING_KIND = 'ping'

type SocketState = 'connecting' | 'open' | 'closed' | 'error'

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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function diagnosticsSocketUrl(): string {
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws'
  return `${scheme}://${window.location.host}${DIAGNOSTICS_PATH}`
}

export function ConsoleApp() {
  const [health, setHealth] = useState<HealthView | null>(null)
  const [healthError, setHealthError] = useState<string | null>(null)
  const [healthLoading, setHealthLoading] = useState(true)
  const [socketState, setSocketState] = useState<SocketState>('connecting')
  const [socketError, setSocketError] = useState<string | null>(null)
  const [lastReply, setLastReply] = useState<string | null>(null)

  const socketRef = useRef<WebSocket | null>(null)
  const healthAbortRef = useRef<AbortController | null>(null)
  const activeRef = useRef(true)

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
      setHealthError(messageOf(error))
    } finally {
      if (isCurrent()) setHealthLoading(false)
    }
  }, [])

  const refreshHealthFromButton = useCallback(() => {
    setHealthLoading(true)
    setHealthError(null)
    void refreshHealth()
  }, [refreshHealth])

  useEffect(() => {
    activeRef.current = true
    const initialFetchTimer = setTimeout(() => {
      void refreshHealth()
    }, 0)

    const socket = new WebSocket(diagnosticsSocketUrl())
    socketRef.current = socket
    socket.onopen = () => {
      setSocketState('open')
      setSocketError(null)
    }
    socket.onclose = (event) => {
      setSocketState('closed')
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
        setLastReply(
          parsed === null ? 'Unrecognised reply from diagnostics server' : JSON.stringify(parsed, null, 2),
        )
      } catch {
        setLastReply('Unrecognised reply from diagnostics server')
      }
    }

    return () => {
      activeRef.current = false
      clearTimeout(initialFetchTimer)
      healthAbortRef.current?.abort()
      socket.onopen = null
      socket.onclose = null
      socket.onerror = null
      socket.onmessage = null
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close(1000, 'console unmounting')
      }
      socketRef.current = null
    }
  }, [refreshHealth])

  const sendPing = useCallback(() => {
    const socket = socketRef.current
    if (socket === null || socket.readyState !== WebSocket.OPEN) return
    socket.send(JSON.stringify({ v: DIAGNOSTICS_PROTOCOL_VERSION, id: `console-${Date.now()}`, kind: PING_KIND }))
  }, [])

  const clearMessages = useCallback(() => {
    setHealthError(null)
    setSocketError(null)
    setLastReply(null)
  }, [])

  return (
    <main className="console">
      <header className="console__header">
        <h1>Isla runtime console</h1>
        <p className="console__subtitle">
          Local diagnostics boundary. Health and protocol checks only; no dialogue, audio or rendering controls.
        </p>
        <div className="console__actions">
          <button type="button" onClick={refreshHealthFromButton} disabled={healthLoading}>
            {healthLoading ? 'Refreshing...' : 'Refresh health'}
          </button>
          <button type="button" onClick={sendPing} disabled={socketState !== 'open'}>
            Ping diagnostics
          </button>
          <button type="button" onClick={clearMessages}>
            Clear messages
          </button>
        </div>
      </header>

      <section className="panel" aria-labelledby="health-heading">
        <div className="panel__heading">
          <h2 id="health-heading">Backend health</h2>
          <span className={`badge badge--${health !== null ? 'ok' : healthError !== null ? 'error' : 'idle'}`}>
            {health !== null ? 'ok' : healthError !== null ? 'unavailable' : 'unknown'}
          </span>
        </div>
        {healthError !== null && <p className="message message--error">{healthError}</p>}
        {health !== null && (
          <dl className="facts">
            <dt>Service</dt>
            <dd>{health.service}</dd>
            <dt>Version</dt>
            <dd>{health.version}</dd>
            <dt>Role</dt>
            <dd>{health.role}</dd>
            <dt>Loopback only</dt>
            <dd>{health.loopbackOnly ? 'yes' : 'no'}</dd>
            <dt>Diagnostics protocol</dt>
            <dd>{health.diagnosticsVersion}</dd>
            <dt>Application protocol</dt>
            <dd>{health.applicationVersion ?? 'not implemented'}</dd>
            <dt>Capabilities</dt>
            <dd>{health.capabilities.join(', ')}</dd>
            <dt>Uptime</dt>
            <dd>{health.uptimeSec.toFixed(1)} s</dd>
          </dl>
        )}
      </section>

      <section className="panel" aria-labelledby="socket-heading">
        <div className="panel__heading">
          <h2 id="socket-heading">Diagnostics socket</h2>
          <span className={`badge badge--${socketState === 'open' ? 'ok' : socketState === 'error' ? 'error' : 'idle'}`}>
            {socketState}
          </span>
        </div>
        <p className="message">{DIAGNOSTICS_PATH} {socketState === 'open' ? 'connected' : 'not connected'}</p>
        {socketError !== null && <p className="message message--error">{socketError}</p>}
        <pre className="reply">{lastReply ?? 'No diagnostics reply yet.'}</pre>
      </section>
    </main>
  )
}
