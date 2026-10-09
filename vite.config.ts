import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const RUNTIME_ORIGIN = 'http://127.0.0.1:4317'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    proxy: {
      '/health': { target: RUNTIME_ORIGIN },
      '/diag': { target: RUNTIME_ORIGIN, ws: true },
    },
  },
})
