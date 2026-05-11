// RPC connection helpers with retry and timeout.

import 'dotenv/config';
import { Connection } from '@solana/web3.js';
import { MAX_RETRIES, RETRY_BASE_DELAY } from './constants';

export function getConnection(): Connection {
  const rpcUrl = process.env.HELIUS_RPC_URL;
  if (!rpcUrl) {
    console.error('Missing HELIUS_RPC_URL in .env');
    process.exit(1);
  }

  return new Connection(rpcUrl, {
    commitment: 'confirmed',
    confirmTransactionInitialTimeout: 30000,
  });
}

/**
 * Retry wrapper with exponential backoff for RPC calls.
 * Retries up to MAX_RETRIES times on failure.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  label: string = 'RPC call'
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e as Error;
      if (attempt < MAX_RETRIES) {
        const delay = RETRY_BASE_DELAY * Math.pow(2, attempt - 1);
        console.warn(
          `  [retry] ${label} failed (attempt ${attempt}/${MAX_RETRIES}), ` +
          `retrying in ${delay}ms: ${lastError.message}`
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  throw lastError;
}

/**
 * Timeout wrapper - resolves with fallback if promise doesn't settle in time.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  fallback: T
): Promise<{ result: T; timedOut: boolean }> {
  let timer: NodeJS.Timeout;
  const timeoutPromise = new Promise<{ result: T; timedOut: boolean }>(
    (resolve) => {
      timer = setTimeout(() => resolve({ result: fallback, timedOut: true }), timeoutMs);
    }
  );

  try {
    const result = await Promise.race([
      promise.then((r) => ({ result: r, timedOut: false })),
      timeoutPromise,
    ]);
    clearTimeout(timer!);
    return result;
  } catch (e) {
    clearTimeout(timer!);
    throw e;
  }
}
