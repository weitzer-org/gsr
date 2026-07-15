import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
    signSession,
    verifySession,
    verifyPassword,
    parseCookie,
    requireAuth,
    handleLogin,
    handleLogout,
    SESSION_COOKIE_NAME,
} from '../src/auth';

function mockRes() {
    const res: any = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    res.redirect = jest.fn().mockReturnValue(res);
    res.cookie = jest.fn().mockReturnValue(res);
    res.clearCookie = jest.fn().mockReturnValue(res);
    return res;
}

describe('parseCookie', () => {
    it('extracts a named cookie from a header with multiple cookies', () => {
        expect(parseCookie('a=1; gsr_auth_session=abc.def; b=2', 'gsr_auth_session')).toBe('abc.def');
    });

    it('returns undefined when the cookie is missing', () => {
        expect(parseCookie('a=1; b=2', 'gsr_auth_session')).toBeUndefined();
    });

    it('returns undefined for an empty header', () => {
        expect(parseCookie(undefined, 'gsr_auth_session')).toBeUndefined();
    });

    it('returns undefined instead of throwing on malformed percent-encoding', () => {
        expect(() => parseCookie('gsr_auth_session=abc%zzdef', 'gsr_auth_session')).not.toThrow();
        expect(parseCookie('gsr_auth_session=abc%zzdef', 'gsr_auth_session')).toBeUndefined();
        expect(parseCookie('gsr_auth_session=%', 'gsr_auth_session')).toBeUndefined();
    });
});

describe('signSession / verifySession', () => {
    it('accepts a freshly signed session for the correct password', () => {
        const token = signSession('correct-horse');
        expect(verifySession(token, 'correct-horse')).toBe(true);
    });

    it('rejects a session signed with a different password', () => {
        const token = signSession('correct-horse');
        expect(verifySession(token, 'wrong-password')).toBe(false);
    });

    it('rejects a malformed token', () => {
        expect(verifySession('not-a-valid-token', 'correct-horse')).toBe(false);
        expect(verifySession(undefined, 'correct-horse')).toBe(false);
    });

    it('rejects an expired token', () => {
        const expiry = Date.now() - 1000;
        const tampered = `${expiry}.somesignature`;
        expect(verifySession(tampered, 'correct-horse')).toBe(false);
    });

    it('rejects a token with a tampered signature', () => {
        const token = signSession('correct-horse');
        const [expiry] = token.split('.');
        expect(verifySession(`${expiry}.tampered-signature`, 'correct-horse')).toBe(false);
    });
});

describe('verifyPassword', () => {
    it('accepts the correct password', () => {
        expect(verifyPassword('hunter2', 'hunter2')).toBe(true);
    });

    it('rejects an incorrect password', () => {
        expect(verifyPassword('wrong', 'hunter2')).toBe(false);
    });

    it('rejects empty/undefined input', () => {
        expect(verifyPassword('', 'hunter2')).toBe(false);
        expect(verifyPassword(undefined, 'hunter2')).toBe(false);
    });
});

describe('requireAuth', () => {
    const originalEnv = process.env.UI_PASSWORD;
    afterEach(() => {
        process.env.UI_PASSWORD = originalEnv;
    });

    it('is a no-op when UI_PASSWORD is not set', () => {
        delete process.env.UI_PASSWORD;
        const req: any = { path: '/api/review', headers: {} };
        const res = mockRes();
        const next = jest.fn();

        requireAuth(req, res, next);

        expect(next).toHaveBeenCalledTimes(1);
        expect(res.status).not.toHaveBeenCalled();
    });

    it('returns 401 JSON for an unauthenticated /api/* request when UI_PASSWORD is set', () => {
        process.env.UI_PASSWORD = 'secret';
        const req: any = { path: '/api/review', headers: {} };
        const res = mockRes();
        const next = jest.fn();

        requireAuth(req, res, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(401);
    });

    it('redirects to /login for an unauthenticated non-API request', () => {
        process.env.UI_PASSWORD = 'secret';
        const req: any = { path: '/', headers: {} };
        const res = mockRes();
        const next = jest.fn();

        requireAuth(req, res, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.redirect).toHaveBeenCalledWith('/login');
    });

    it('calls next() when a valid session cookie is present', () => {
        process.env.UI_PASSWORD = 'secret';
        const token = signSession('secret');
        const req: any = { path: '/api/review', headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` } };
        const res = mockRes();
        const next = jest.fn();

        requireAuth(req, res, next);

        expect(next).toHaveBeenCalledTimes(1);
        expect(res.status).not.toHaveBeenCalled();
    });
});

describe('handleLogin', () => {
    const originalEnv = process.env.UI_PASSWORD;
    afterEach(() => {
        process.env.UI_PASSWORD = originalEnv;
    });

    it('returns 503 when UI_PASSWORD is not configured', () => {
        delete process.env.UI_PASSWORD;
        const req: any = { body: { password: 'anything' } };
        const res = mockRes();

        handleLogin(req, res);

        expect(res.status).toHaveBeenCalledWith(503);
    });

    it('returns 401 for an incorrect password', () => {
        process.env.UI_PASSWORD = 'secret';
        const req: any = { body: { password: 'wrong' } };
        const res = mockRes();

        handleLogin(req, res);

        expect(res.status).toHaveBeenCalledWith(401);
        expect(res.cookie).not.toHaveBeenCalled();
    });

    it('sets a session cookie for the correct password', () => {
        process.env.UI_PASSWORD = 'secret';
        const req: any = { body: { password: 'secret' } };
        const res = mockRes();

        handleLogin(req, res);

        expect(res.cookie).toHaveBeenCalledTimes(1);
        expect(res.cookie.mock.calls[0][0]).toBe(SESSION_COOKIE_NAME);
        expect(res.cookie.mock.calls[0][2]).toMatchObject({ httpOnly: true, sameSite: 'lax' });
        expect(res.json).toHaveBeenCalledWith({ status: 'success' });
    });
});

describe('handleLogout', () => {
    it('clears the session cookie with the same attributes it was set with', () => {
        const req: any = {};
        const res = mockRes();

        handleLogout(req, res);

        expect(res.clearCookie).toHaveBeenCalledTimes(1);
        expect(res.clearCookie.mock.calls[0][0]).toBe(SESSION_COOKIE_NAME);
        expect(res.clearCookie.mock.calls[0][1]).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/' });
        expect(res.json).toHaveBeenCalledWith({ status: 'success' });
    });
});
