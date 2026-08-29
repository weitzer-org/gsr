import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.mock('../storage');

import * as storage from '../storage';
import * as usage from '../usage';

const mockUploadResultsToGCS = storage.uploadResultsToGCS as jest.Mock;

describe('computeCostUsd', () => {
    it('computes cost for a known model', () => {
        const cost = usage.computeCostUsd('gemini-2.5-pro', 1_000_000, 1_000_000);
        expect(cost).toBeCloseTo(1.25 + 10.0, 5);
    });

    it('bills thinking tokens at the output rate', () => {
        const cost = usage.computeCostUsd('gemini-2.5-pro', 0, 0, 0, 1_000_000);
        expect(cost).toBeCloseTo(10.0, 5);
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
