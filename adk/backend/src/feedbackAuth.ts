// Auth for POST/GET /api/findings/feedback (finding-feedback-requirements.md
// §5.2). Accepts EITHER a valid FEEDBACK_SHARED_SECRET header (the headless
// consumer path — an AI coding agent, an MCP client, a downstream Action)
// OR a valid gsr_auth_session cookie (the browser path, reusing 100% of
// existing UI_PASSWORD login infra) — so one endpoint serves both without
// two implementations.
//
// Like usageIngestAuth.ts's isValidUsageIngestKey and UNLIKE tools/eval's
// isValidInternalKey, this fails closed: this is a new INBOUND write
// endpoint on a publicly-discoverable app (CLAUDE.md's Auth section), so an
// unconfigured secret must never mean "always allow." If FEEDBACK_SHARED_SECRET
// is unset, the header path always rejects; the cookie path still works if
// UI_PASSWORD is separately configured (e.g. a browser-only deployment that
// hasn't opted into the headless-agent path yet).
import { timingSafeStringEqual, verifySession, parseCookie, SESSION_COOKIE_NAME } from './auth';

export function isValidFeedbackKey(provided: string | undefined, expected: string | undefined): boolean {
  if (!expected || !provided) return false;
  return timingSafeStringEqual(provided, expected);
}

export function isValidFeedbackRequest(headerKey: string | undefined, cookieHeader: string | undefined): boolean {
  if (isValidFeedbackKey(headerKey, process.env.FEEDBACK_SHARED_SECRET)) return true;

  const password = process.env.UI_PASSWORD;
  if (!password) return false;
  return verifySession(parseCookie(cookieHeader, SESSION_COOKIE_NAME), password);
}

// Called once at startup, alongside assertProductionAuthConfigured() /
// assertProductionUsageIngestConfigured(). §5.2's explicit departure from
// the EVALUATOR_SHARED_SECRET precedent: that secret is optional/warn-only
// because it protects an *outbound* call the backend itself makes; this one
// protects a new *inbound*, publicly-reachable write endpoint. isValidFeedbackKey
// already fails closed on an unset secret (rejects every header-keyed request
// rather than accepting them), so the risk here isn't an open endpoint — it's
// a silently DEAD one: the headless-agent path (an AI coding agent, a
// downstream Action) this endpoint primarily exists for would be permanently
// unreachable, with the only symptom being 401s nobody notices, mirroring
// usageIngestAuth.ts's assertProductionUsageIngestConfigured's reasoning
// exactly. Same strictness as UI_PASSWORD, still — refusing to boot loudly is
// better than deploying a route no headless consumer can ever use.
export function assertProductionFeedbackAuthConfigured(): void {
  if (process.env.NODE_ENV !== 'production') return;

  if (!process.env.FEEDBACK_SHARED_SECRET) {
    throw new Error(
      'FEEDBACK_SHARED_SECRET is not set. Refusing to start in production ' +
      'without it — POST /api/findings/feedback would otherwise be ' +
      'permanently unreachable for any non-browser consumer (an AI coding ' +
      'agent, a downstream Action) with no way to notice, since the ' +
      'session-cookie fallback only covers the browser path. Set it with ' +
      '`fly secrets set`.'
    );
  }
}
