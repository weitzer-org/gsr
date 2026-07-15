import { isValidInternalKey, assertProductionSecretConfigured } from '../internalAuth';

describe('isValidInternalKey', () => {
    it('allows any request when no secret is configured', () => {
        expect(isValidInternalKey(undefined, undefined)).toBe(true);
        expect(isValidInternalKey('anything', undefined)).toBe(true);
    });

    it('accepts a matching key', () => {
        expect(isValidInternalKey('shared-secret', 'shared-secret')).toBe(true);
    });

    it('rejects a mismatched key', () => {
        expect(isValidInternalKey('wrong', 'shared-secret')).toBe(false);
    });

    it('rejects a missing key when a secret is configured', () => {
        expect(isValidInternalKey(undefined, 'shared-secret')).toBe(false);
    });
});

describe('assertProductionSecretConfigured', () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalSecret = process.env.EVALUATOR_SHARED_SECRET;

    afterEach(() => {
        process.env.NODE_ENV = originalNodeEnv;
        process.env.EVALUATOR_SHARED_SECRET = originalSecret;
    });

    it('is a no-op outside production', () => {
        process.env.NODE_ENV = 'development';
        delete process.env.EVALUATOR_SHARED_SECRET;
        expect(() => assertProductionSecretConfigured()).not.toThrow();
    });

    it('throws in production when EVALUATOR_SHARED_SECRET is unset', () => {
        process.env.NODE_ENV = 'production';
        delete process.env.EVALUATOR_SHARED_SECRET;
        expect(() => assertProductionSecretConfigured()).toThrow(/EVALUATOR_SHARED_SECRET is not set/);
    });

    it('does not throw in production when EVALUATOR_SHARED_SECRET is set', () => {
        process.env.NODE_ENV = 'production';
        process.env.EVALUATOR_SHARED_SECRET = 'shared-secret';
        expect(() => assertProductionSecretConfigured()).not.toThrow();
    });
});
