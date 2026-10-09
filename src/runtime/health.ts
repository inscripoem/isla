import type { HealthResponse } from '../contracts'
import {
  APPLICATION_PROTOCOL_VERSION,
  DIAGNOSTICS_PROTOCOL_VERSION,
  SERVICE_NAME,
  SERVICE_VERSION,
} from '../contracts'

export function createHealthResponse(uptimeSec: number): HealthResponse {
  return {
    ok: true,
    service: SERVICE_NAME,
    version: SERVICE_VERSION,
    role: 'diagnostics-foundation',
    loopbackOnly: true,
    protocol: {
      diagnostics: DIAGNOSTICS_PROTOCOL_VERSION,
      application: APPLICATION_PROTOCOL_VERSION,
    },
    capabilities: ['health', 'diagnostics'],
    uptimeSec: Math.round(uptimeSec * 10) / 10,
  }
}