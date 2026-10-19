/**
 * Deprecated location. The application transport schemas now live in the shared,
 * browser-safe contracts subtree (`src/contracts/app/transport.ts`). This module
 * re-exports them for internal convenience; new code should import from
 * `src/contracts`.
 */
export * from '../contracts/app/transport'
