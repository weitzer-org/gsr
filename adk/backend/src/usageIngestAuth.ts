import { timingSafeStringEqual } from './auth';

// Unlike tools/eval/internalAuth.ts's isValidInternalKey (open when its
// secret is unset — fine for a two-service internal link behind other
// boundaries), this MUST fail closed: POST /api/usage/ingest is registered
// before requireAuth (public Action consumers have no UI_PASSWORD session),
// so this check is the route's only protection. An unset or mismatched
// secret always rejects, never "always allow."
export function isValidUsageIngestKey(provided: string | undefined, expected: string | undefined): boolean {
  if (!expected || !provided) return false;
  return timingSafeStringEqual(provided, expected);
}

// Called once at startup, alongside assertProductionAuthConfigured(). This
// secret is the sole protection on /api/usage/ingest, so — like tools/eval's
// assertProductionSecretConfigured — production refuses to start without it,
// rather than deploying a route that's silently dead (isValidUsageIngestKey
// fails closed either way, but a silently-dead opt-in feature is exactly the
// kind of gap this repo's startup guards exist to catch loudly instead).
export function assertProductionUsageIngestConfigured(): void {
  if (process.env.NODE_ENV !== 'production') return;

  if (!process.env.USAGE_INGEST_SHARED_SECRET) {
    throw new Error(
      'USAGE_INGEST_SHARED_SECRET is not set. Refusing to start in production ' +
      'without it — POST /api/usage/ingest would otherwise be permanently ' +
      'unreachable with no way to notice. Set it with `fly secrets set`.'
    );
  }
}
