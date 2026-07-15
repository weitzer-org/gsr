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

/**
 * Called once at server startup. This service is a standalone public Fly
 * app with no auth of its own beyond EVALUATOR_SHARED_SECRET — unlike the
 * main backend (which falls back to a password-gated UI), there's no other
 * boundary protecting it, so production refuses to start without it rather
 * than silently serving an open /api/evaluate.
 */
export function assertProductionSecretConfigured(): void {
  if (process.env.NODE_ENV !== 'production') return;

  if (!process.env.EVALUATOR_SHARED_SECRET) {
    throw new Error(
      'EVALUATOR_SHARED_SECRET is not set. Refusing to start in production ' +
      'without it — this service was previously deployed with no auth at ' +
      'all, and that is the gap this check exists to prevent. Set it with ' +
      '`fly secrets set`.'
    );
  }
}
