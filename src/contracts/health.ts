export interface HealthResponse {
  ok: true
  service: string
  version: string
  role: string
  loopbackOnly: boolean
  protocol: {
    diagnostics: number
    application: number | null
  }
  capabilities: string[]
  uptimeSec: number
}