import type { ControlAuthorizerPort, TrustedControlContext } from '../contracts'

/**
 * Production control authorizer. Operator authority is established by the
 * transport boundary (a same-origin, one-time operator bootstrap) and never by
 * a self-reported payload role. A connection context is trusted only when the
 * server assigned the operator role and marked the connection authenticated.
 */
export function createRuntimeAuthorizer(): ControlAuthorizerPort {
  return {
    isOperator: (context: TrustedControlContext): boolean =>
      context.role === 'operator' && context.authenticated,
  }
}
