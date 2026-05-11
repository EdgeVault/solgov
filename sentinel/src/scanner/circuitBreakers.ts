// Detect protocol-specific circuit breakers (rate limits, withdrawal caps, pause guards).

import { Connection } from '@solana/web3.js';

export interface CircuitBreakerResult {
  programId: string;
  hasCircuitBreakers: 'unknown' | 'yes' | 'no';
  hasWithdrawalRateLimits: 'unknown' | 'yes' | 'no';
  hasAutoPause: 'unknown' | 'yes' | 'no';
  hasNewMarketDelay: 'unknown' | 'yes' | 'no';
  warning: string | null;
}

/**
 * Circuit breaker detection stub.
 *
 * Detecting circuit breakers requires protocol-specific IDL decoding
 * to read each protocol's global state accounts. This is a Phase 2 feature
 * that will need per-protocol IDLs stored in src/protocols/idls/.
 *
 * For now, returns "unknown" for all fields.
 */
export async function checkCircuitBreakers(
  _connection: Connection,
  programId: string
): Promise<CircuitBreakerResult> {
  return {
    programId,
    hasCircuitBreakers: 'unknown',
    hasWithdrawalRateLimits: 'unknown',
    hasAutoPause: 'unknown',
    hasNewMarketDelay: 'unknown',
    warning:
      'Circuit breaker detection requires protocol-specific IDL decoding. ' +
      'This will be implemented per-protocol in a future update.',
  };
}
