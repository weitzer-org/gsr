import * as crypto from 'crypto';

/**
 * Validates the shared secret the main backend attaches (X-Internal-Key) when
 * triggering a remote evaluation run. A no-op (always valid) when
 * EVALUATOR_SHARED_SECRET isn't configured, matching this repo's convention
 * of optional secrets being local-dev/test no-ops rather than hard failures.
 */
export function isValidInternalKey(provided: string | undefined, expected: string | undefined): boolean {
  if (!expected) return true;
  if (!provided) return false;

  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  return providedBuf.length === expectedBuf.length && crypto.timingSafeEqual(providedBuf, expectedBuf);
}
