import { describe, it, expect, afterEach } from '@jest/globals';
import { isValidUsageIngestKey, assertProductionUsageIngestConfigured } from '../src/usageIngestAuth';

describe('isValidUsageIngestKey', () => {
    // The key divergence from tools/eval's isValidInternalKey, which treats
    // an unset secret as "always valid" — wrong here, since this route sits
    // in front of no other gate and is reachable by the public internet.
    it('rejects any request when no secret is configured, unlike isValidInternalKey', () => {
        expect(isValidUsageIngestKey(undefined, undefined)).toBe(false);
        expect(isValidUsageIngestKey('anything', undefined)).toBe(false);
    });

    it('accepts a matching key', () => {
        expect(isValidUsageIngestKey('shared-secret', 'shared-secret')).toBe(true);
    });

    it('rejects a mismatched key', () => {
        expect(isValidUsageIngestKey('wrong', 'shared-secret')).toBe(false);
    });

    it('rejects a missing key when a secret is configured', () => {
        expect(isValidUsageIngestKey(undefined, 'shared-secret')).toBe(false);
    });
});

describe('assertProductionUsageIngestConfigured', () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalSecret = process.env.USAGE_INGEST_SHARED_SECRET;

    afterEach(() => {
        process.env.NODE_ENV = originalNodeEnv;
        process.env.USAGE_INGEST_SHARED_SECRET = originalSecret;
    });

    it('is a no-op outside production', () => {
        process.env.NODE_ENV = 'development';
        delete process.env.USAGE_INGEST_SHARED_SECRET;
        expect(() => assertProductionUsageIngestConfigured()).not.toThrow();
    });

    it('throws in production when USAGE_INGEST_SHARED_SECRET is unset', () => {
        process.env.NODE_ENV = 'production';
        delete process.env.USAGE_INGEST_SHARED_SECRET;
        expect(() => assertProductionUsageIngestConfigured()).toThrow(/USAGE_INGEST_SHARED_SECRET is not set/);
    });

    it('does not throw in production when USAGE_INGEST_SHARED_SECRET is set', () => {
        process.env.NODE_ENV = 'production';
        process.env.USAGE_INGEST_SHARED_SECRET = 'shared-secret';
        expect(() => assertProductionUsageIngestConfigured()).not.toThrow();
    });
});
