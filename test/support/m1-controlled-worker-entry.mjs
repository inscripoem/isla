/**
 * Test-only controlled worker thread for the M1 worker host.
 *
 * Injected only through the `createWorker` test seam. It runs as a real
 * `node:worker_threads` thread and speaks the host's real message protocol, but
 * it is fully scripted: it never imports Kokoro, the SDK or a model, and it
 * holds each generation until the test posts a `test:complete`/`test:fail`
 * control message. The host's `dispose` request is accepted but the thread
 * exits only on the explicit `test:exit` control, so the difference between the
 * dispose request and the actual thread exit stays observable. This fixture
 * does not replace the production host and proves nothing about real Kokoro
 * inference or acoustic output.
 */
import { parentPort } from 'node:worker_threads'

if (parentPort === null) {
  throw new Error('controlled worker entry requires a parent port')
}

const held = new Map()

parentPort.on('message', (message) => {
  if (message === null || typeof message !== 'object') return
  switch (message.kind) {
    case 'generate':
      // Hold the job until the test settles it; nothing is generated here.
      held.set(message.jobId, message)
      return
    case 'dispose':
      // Disposal is observed by the host-side fixture through its post log; the
      // thread stays alive until the explicit exit control.
      return
    case 'test:ready':
      parentPort.postMessage({ kind: 'ready' })
      return
    case 'test:complete': {
      if (!held.has(message.jobId)) return
      held.delete(message.jobId)
      parentPort.postMessage({
        kind: 'result',
        jobId: message.jobId,
        ok: true,
        sampleRate: typeof message.sampleRate === 'number' ? message.sampleRate : 24000,
        samples:
          message.samples instanceof Float32Array
            ? message.samples
            : new Float32Array([0.25, -0.25]),
      })
      return
    }
    case 'test:fail': {
      if (!held.has(message.jobId)) return
      held.delete(message.jobId)
      parentPort.postMessage({
        kind: 'result',
        jobId: message.jobId,
        ok: false,
        error: typeof message.error === 'string' ? message.error : 'controlled worker failure',
      })
      return
    }
    case 'test:exit':
      parentPort.close()
      return
    default:
      return
  }
})
