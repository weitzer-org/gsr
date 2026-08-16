import { describe, it, expect, afterEach } from '@jest/globals';
import { isValidFeedbackKey, isValidFeedbackRequest, assertProductionFeedbackAuthConfigured } from '../src/feedbackAuth';
import { signSession } from '../src/auth';

describe('isValidFeedbackKey', () => {
    it('rejects any request when no secret is configured, unlike isValidInternalKey', () => {
        expect(isValidFeedbackKey(undefined, undefined)).toBe(false);
        expect(isValidFeedbackKey('anything', undefined)).toBe(false);
    });

    it('accepts a matching key', () => {
        expect(isValidFeedbackKey('shared-secret', 'shared-secret')).toBe(true);
    });

    it('rejects a mismatched key', () => {
        expect(isValidFeedbackKey('wrong', 'shared-secret')).toBe(false);
    });

    it('rejects a missing key when a secret is configured', () => {
        expect(isValidFeedbackKey(undefined, 'shared-secret')).toBe(false);
    });
});

describe('isValidFeedbackRequest (either/or: header key or session cookie)', () => {
    const originalSecret = process.env.FEEDBACK_SHARED_SECRET;
    const originalPassword = process.env.UI_PASSWORD;

    // Self-review finding: `process.env.X = undefined` coerces to the
    // literal string "undefined" (Node.js env vars are always strings), not
    // "unset" — restoring naively would leave the var permanently truthy for
    // later tests in this file/process if it started out unset. Restore-or-
    // delete instead.
    afterEach(() => {
        if (originalSecret === undefined) delete process.env.FEEDBACK_SHARED_SECRET;
        else process.env.FEEDBACK_SHARED_SECRET = originalSecret;
        if (originalPassword === undefined) delete process.env.UI_PASSWORD;
        else process.env.UI_PASSWORD = originalPassword;
    });

    it('rejects when neither the key nor a session is configured/provided', () => {
        delete process.env.FEEDBACK_SHARED_SECRET;
        delete process.env.UI_PASSWORD;
        expect(isValidFeedbackRequest(undefined, undefined)).toBe(false);
    });

    it('accepts a valid shared-secret header', () => {
        process.env.FEEDBACK_SHARED_SECRET = 'feedback-test-secret';
        expect(isValidFeedbackRequest('feedback-test-secret', undefined)).toBe(true);
    });

    it('rejects a wrong shared-secret header even with no session configured', () => {
        process.env.FEEDBACK_SHARED_SECRET = 'feedback-test-secret';
        delete process.env.UI_PASSWORD;
        expect(isValidFeedbackRequest('wrong', undefined)).toBe(false);
    });

    it('accepts a valid session cookie when the header key is absent', () => {
        delete process.env.FEEDBACK_SHARED_SECRET;
        process.env.UI_PASSWORD = 'ui-password';
        const cookie = `gsr_auth_session=${signSession('ui-password')}`;
        expect(isValidFeedbackRequest(undefined, cookie)).toBe(true);
    });

    it('rejects an invalid session cookie when no shared secret is configured', () => {
        delete process.env.FEEDBACK_SHARED_SECRET;
        process.env.UI_PASSWORD = 'ui-password';
        expect(isValidFeedbackRequest(undefined, 'gsr_auth_session=garbage')).toBe(false);
    });

    it('accepts the header key even when a session is also configured but the cookie is missing', () => {
        process.env.FEEDBACK_SHARED_SECRET = 'feedback-test-secret';
        process.env.UI_PASSWORD = 'ui-password';
        expect(isValidFeedbackRequest('feedback-test-secret', undefined)).toBe(true);
    });
});

describe('assertProductionFeedbackAuthConfigured', () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalSecret = process.env.FEEDBACK_SHARED_SECRET;

    afterEach(() => {
        process.env.NODE_ENV = originalNodeEnv;
        process.env.FEEDBACK_SHARED_SECRET = originalSecret;
    });

    it('is a no-op outside production', () => {
        process.env.NODE_ENV = 'development';
        delete process.env.FEEDBACK_SHARED_SECRET;
        expect(() => assertProductionFeedbackAuthConfigured()).not.toThrow();
    });

    it('throws in production when FEEDBACK_SHARED_SECRET is unset', () => {
        process.env.NODE_ENV = 'production';
        delete process.env.FEEDBACK_SHARED_SECRET;
        expect(() => assertProductionFeedbackAuthConfigured()).toThrow(/FEEDBACK_SHARED_SECRET is not set/);
    });

    it('does not throw in production when FEEDBACK_SHARED_SECRET is set', () => {
        process.env.NODE_ENV = 'production';
        process.env.FEEDBACK_SHARED_SECRET = 'feedback-test-secret';
        expect(() => assertProductionFeedbackAuthConfigured()).not.toThrow();
    });
});
