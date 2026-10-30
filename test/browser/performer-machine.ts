/**
 * Browser-safe performer state machine shim.
 *
 * The implementation moved to the production module
 * `src/console/performer-machine.ts` under the owner-reviewed M2 extraction.
 * This module re-exports it unchanged so existing test importers keep their
 * names and behaviour, and additionally re-exports the M1 playback controller
 * factory that the shared machine has always surfaced from here.
 */
export * from '../../src/console/performer-machine'
export { createPlaybackController } from '../../src/performance/browser/player'
