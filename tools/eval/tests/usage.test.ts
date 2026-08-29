import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';

jest.mock('../storage');
jest.mock('../../../adk/backend/src/usageReporter');

import * as storage from '../storage';
import * as usageReporter from '../../../adk/backend/src/usageReporter';
import * as usage from '../usage';

const mockUploadResultsToGCS = storage.uploadResultsToGCS as jest.Mock;
const mockReportUsage = usageReporter.reportUsage as jest.Mock;

describe('computeCostUsd', () => {
    it('computes cost for a known model', () => {
        const cost = usage.computeCostUsd('gemini-2.5-pro', 1_000_000, 1_000_000);
        expect(cost).toBeCloseTo(1.25 + 10.0, 5);
    });

    it('does not bill a stray 5th argument (avoids double-counting candidatesTokenCount)', () => {
        const cost = (usage.computeCostUsd as any)('gemini-2.5-pro', 0, 0, 0, 1_000_000);
        expect(cost).toBe(0);
    });

    it('returns 0 for an unknown model', () => {
        expect(usage.computeCostUsd('some-future-model', 1000, 1000)).toBe(0);
    });
});

describe('classifyError', () => {
    it('classifies a 429 status as rate_limit', () => {
        expect(usage.classifyError({ status: 429 })).toBe('rate_limit');
    });

    it('falls back to api_error for anything unrecognized', () => {
        expect(usage.classifyError(new Error('some unrelated failure'))).toBe('api_error');
    });
});

describe('trackGeminiCall', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        // @ts-ignore
        mockUploadResultsToGCS.mockResolvedValue(undefined);
    });

    it('records a successful call, tags it with the fixed repository label, and returns the response unchanged', async () => {
        const response = { text: 'ok', usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 10, thoughtsTokenCount: 5 } };
        const result = await usage.trackGeminiCall({ callType: 'llm_compare', model: 'gemini-2.5-pro' }, () => Promise.resolve(response));

        expect(result).toBe(response);
        expect(mockUploadResultsToGCS).toHaveBeenCalledTimes(1);
        const [, , data] = mockUploadResultsToGCS.mock.calls[0] as [string, string, any];
        expect(data.success).toBe(true);
        expect(data.inputTokens).toBe(50);
        expect(data.thinkingTokens).toBe(5);
        expect(data.repository).toBe('tools-eval (local)');
        expect(data.callType).toBe('llm_compare');
    });

    it('records a failed call with a classified errorKind and rethrows unchanged', async () => {
        const original = Object.assign(new Error('boom'), { status: 429 });
        await expect(
            usage.trackGeminiCall({ callType: 'llm_compare', model: 'gemini-2.5-pro' }, () => Promise.reject(original))
        ).rejects.toBe(original);

        const [, , data] = mockUploadResultsToGCS.mock.calls[0] as [string, string, any];
        expect(data.success).toBe(false);
        expect(data.errorKind).toBe('rate_limit');
    });

    it('never throws when the upload itself fails', async () => {
        // @ts-ignore
        mockUploadResultsToGCS.mockRejectedValueOnce(new Error('network down'));
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

        await expect(
            usage.trackGeminiCall({ callType: 'llm_compare', model: 'gemini-2.5-pro' }, () => Promise.resolve({ text: 'ok' } as any))
        ).resolves.toEqual({ text: 'ok' });

        expect(errorSpy).toHaveBeenCalled();
        errorSpy.mockRestore();
    });
});

describe('recordUsage (production reporting)', () => {
    const originalSecret = process.env.USAGE_INGEST_SHARED_SECRET;
    const originalUrl = process.env.USAGE_INGEST_URL;

    beforeEach(() => {
        jest.clearAllMocks();
        // @ts-ignore
        mockUploadResultsToGCS.mockResolvedValue(undefined);
        // @ts-ignore
        mockReportUsage.mockResolvedValue({ batchesSent: 1, batchesFailed: 0 });
        delete process.env.USAGE_INGEST_SHARED_SECRET;
        delete process.env.USAGE_INGEST_URL;
    });

    afterEach(() => {
        // Restore only the specific keys this suite touches, rather than
        // reassigning process.env wholesale — Node's process.env is a
        // special binding (e.g. it auto-stringifies assigned values), and
        // replacing the whole object with a plain one loses that for the
        // rest of the process.
        if (originalSecret !== undefined) process.env.USAGE_INGEST_SHARED_SECRET = originalSecret;
        else delete process.env.USAGE_INGEST_SHARED_SECRET;
        if (originalUrl !== undefined) process.env.USAGE_INGEST_URL = originalUrl;
        else delete process.env.USAGE_INGEST_URL;
    });

    it('reports to the production ingest endpoint when a shared secret is configured', async () => {
        process.env.USAGE_INGEST_SHARED_SECRET = 'test-secret';
        await usage.recordUsage({ callType: 'llm_compare', model: 'gemini-2.5-pro', inputTokens: 1, outputTokens: 1, latencyMs: 1, costUsd: 0, success: true });

        expect(mockReportUsage).toHaveBeenCalledTimes(1);
        const [records, config] = mockReportUsage.mock.calls[0] as [any[], any];
        expect(records).toHaveLength(1);
        expect(records[0].callType).toBe('llm_compare');
        expect(config.key).toBe('test-secret');
        expect(config.url).toBe('https://gsr-code-review.fly.dev/api/usage/ingest');
        expect(config.repository).toBe('tools-eval (local)');
    });

    it('uses USAGE_INGEST_URL as an override when set', async () => {
        process.env.USAGE_INGEST_SHARED_SECRET = 'test-secret';
        process.env.USAGE_INGEST_URL = 'https://staging.example.com/api/usage/ingest';
        await usage.recordUsage({ callType: 'llm_compare', model: 'gemini-2.5-pro', inputTokens: 1, outputTokens: 1, latencyMs: 1, costUsd: 0, success: true });

        const [, config] = mockReportUsage.mock.calls[0] as [any[], any];
        expect(config.url).toBe('https://staging.example.com/api/usage/ingest');
    });

    it('skips production reporting without failing when no shared secret is configured, but still records locally', async () => {
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

        await usage.recordUsage({ callType: 'llm_compare', model: 'gemini-2.5-pro', inputTokens: 1, outputTokens: 1, latencyMs: 1, costUsd: 0, success: true });
        await usage.recordUsage({ callType: 'llm_compare', model: 'gemini-2.5-pro', inputTokens: 1, outputTokens: 1, latencyMs: 1, costUsd: 0, success: true });

        expect(mockReportUsage).not.toHaveBeenCalled();
        expect(mockUploadResultsToGCS).toHaveBeenCalledTimes(2); // local write still happens either way
        warnSpy.mockRestore();
    });

    it('swallows a local write failure without rejecting, and still attempts the production report', async () => {
        process.env.USAGE_INGEST_SHARED_SECRET = 'test-secret';
        // @ts-ignore
        mockUploadResultsToGCS.mockRejectedValueOnce(new Error('GCS error'));
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

        await expect(
            usage.recordUsage({ callType: 'llm_compare', model: 'gemini-2.5-pro', inputTokens: 1, outputTokens: 1, latencyMs: 1, costUsd: 0, success: true })
        ).resolves.toBeUndefined();

        expect(errorSpy).toHaveBeenCalled();
        expect(mockReportUsage).toHaveBeenCalledTimes(1); // independent of the local write's outcome
        errorSpy.mockRestore();
    });

    it('swallows a production report failure without rejecting, and still writes locally', async () => {
        process.env.USAGE_INGEST_SHARED_SECRET = 'test-secret';
        // @ts-ignore
        mockReportUsage.mockRejectedValueOnce(new Error('network down'));
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

        await expect(
            usage.recordUsage({ callType: 'llm_compare', model: 'gemini-2.5-pro', inputTokens: 1, outputTokens: 1, latencyMs: 1, costUsd: 0, success: true })
        ).resolves.toBeUndefined();

        expect(errorSpy).toHaveBeenCalled();
        expect(mockUploadResultsToGCS).toHaveBeenCalledTimes(1); // independent of the report's outcome
        errorSpy.mockRestore();
    });
});
