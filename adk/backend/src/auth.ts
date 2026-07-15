import * as crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';

export const SESSION_COOKIE_NAME = 'gsr_auth_session';
export const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Shared between set (login) and clear (logout) — browsers key cookie
// identity on path/secure/sameSite too, so a mismatch can leave the cookie
// un-clearable in some browsers.
const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  path: '/',
};

// SESSION_SECRET is optional and independent of UI_PASSWORD (falls back to
// the password if unset, preserving prior behavior for existing
// deployments). Setting it decouples the two: a captured session token no
// longer lets an attacker brute-force the login password offline, since the
// HMAC key isn't the password itself.
function sign(expiry: number, password: string): string {
  const key = process.env.SESSION_SECRET || password;
  return crypto.createHmac('sha256', key).update(String(expiry)).digest('base64url');
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  return aBuf.length === bBuf.length && crypto.timingSafeEqual(aBuf, bBuf);
}

/** Stateless signed session token: "<expiryMs>.<hmac(expiryMs, password)>". No server-side session store. */
export function signSession(password: string): string {
  const expiry = Date.now() + SESSION_DURATION_MS;
  return `${expiry}.${sign(expiry, password)}`;
}

export function verifySession(token: string | undefined, password: string): boolean {
  if (!token) return false;
  const dotIndex = token.indexOf('.');
  if (dotIndex === -1) return false;

  const expiry = Number(token.slice(0, dotIndex));
  const signature = token.slice(dotIndex + 1);
  if (!Number.isFinite(expiry) || Date.now() > expiry || !signature) return false;

  return timingSafeStringEqual(signature, sign(expiry, password));
}

export function verifyPassword(submitted: string | undefined, password: string): boolean {
  return typeof submitted === 'string' && submitted.length > 0 && timingSafeStringEqual(submitted, password);
}

export function parseCookie(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return undefined; // malformed percent-encoding — treat as no cookie, not a crash
      }
    }
  }
  return undefined;
}

/**
 * Gates every route it's mounted after. Auth is intentionally a no-op when
 * UI_PASSWORD isn't set (local dev / test convenience, same convention as
 * this repo's other optional secrets) — set it via `fly secrets set` to
 * actually lock down a deployment.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const password = process.env.UI_PASSWORD;
  if (!password) {
    return next();
  }

  const token = parseCookie(req.headers.cookie, SESSION_COOKIE_NAME);
  if (verifySession(token, password)) {
    return next();
  }

  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  res.redirect('/login');
}

export function handleLogin(req: Request, res: Response) {
  const password = process.env.UI_PASSWORD;
  if (!password) {
    return res.status(503).json({ error: 'UI_PASSWORD is not configured on the server.' });
  }

  if (!verifyPassword(req.body?.password, password)) {
    return res.status(401).json({ error: 'Invalid password.' });
  }

  res.cookie(SESSION_COOKIE_NAME, signSession(password), {
    ...SESSION_COOKIE_OPTIONS,
    maxAge: SESSION_DURATION_MS,
  });
  res.json({ status: 'success' });
}

export function handleLogout(req: Request, res: Response) {
  res.clearCookie(SESSION_COOKIE_NAME, SESSION_COOKIE_OPTIONS);
  res.json({ status: 'success' });
}

/**
 * Called once at server startup. UI_PASSWORD's "no-op when unset" convention
 * is deliberate for local dev/test, but the same silent-fail-open in
 * production is exactly the gap this app was previously deployed with
 * (public URL, zero auth) — so production refuses to start without it,
 * rather than quietly serving unauthenticated. EVALUATOR_SHARED_SECRET only
 * warns here: it's the *evaluator's* job to hard-enforce its own secret
 * (see tools/eval/internalAuth.ts) since that's the boundary that actually
 * protects it; this app just attaches the header when calling out.
 */
export function assertProductionAuthConfigured(): void {
  if (process.env.NODE_ENV !== 'production') return;

  if (!process.env.UI_PASSWORD) {
    throw new Error(
      'UI_PASSWORD is not set. Refusing to start in production without it — ' +
      'this app was previously deployed with no auth at all, and that is the ' +
      'gap this check exists to prevent. Set it with `fly secrets set`.'
    );
  }
  if (!process.env.EVALUATOR_SHARED_SECRET) {
    console.warn(
      '[Auth] EVALUATOR_SHARED_SECRET is not set — the remote evaluation ' +
      'trigger (POST /api/evals/start with evalRunner=production) will call ' +
      'the evaluator with no auth header attached.'
    );
  }
}
