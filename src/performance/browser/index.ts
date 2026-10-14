/**
 * Public browser-safe entry for the M1 performance subtree. M2 may import this
 * module; every transitive import stays free of Node, backend and test code.
 */
export * from './types'
export { M1_PLAYER_SOURCE, createPlaybackController } from './player'
export { createPlayerPort } from './player-port'
export { createDomMediaDriver } from './dom-driver'
