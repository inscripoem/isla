import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const RUNTIME_ORIGIN = 'http://127.0.0.1:4317'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    // The root entry serves the diagnostics console and forwards the runtime
    // routes on the same origin: diagnostics (`/health`, `/diag`), the
    // application socket (`/app`, WebSocket), the operator bootstrap
    // (`/operator`, HTTP) and the dynamic audio resource fetch (`/audio`, HTTP
    // POST). The proxy forwards the original `Origin` and `Host`, so the
    // runtime's own origin/host checks still decide whether a connection,
    // bootstrap or audio fetch is allowed.
    proxy: {
      '/health': { target: RUNTIME_ORIGIN },
      '/diag': { target: RUNTIME_ORIGIN, ws: true },
      '/app': { target: RUNTIME_ORIGIN, ws: true },
      '/operator': { target: RUNTIME_ORIGIN },
      '/audio': { target: RUNTIME_ORIGIN },
    },
  },
})
