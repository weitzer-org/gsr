import { jest, describe, it, expect } from '@jest/globals';
import { chunkRecords, reportUsage, DEFAULT_USAGE_REPORT_BATCH_SIZE } from '../src/usageReporter';

describe('chunkRecords', () => {
    it('returns an empty array for an empty input', () => {
        expect(chunkRecords([], 10)).toEqual([]);
    });

    it('splits evenly when the input is an exact multiple of the batch size', () => {
        expect(chunkRecords([1, 2, 3, 4], 2)).toEqual([[1, 2], [3, 4]]);
    });

    it('puts the remainder in a final short batch', () => {
        expect(chunkRecords([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    });

    // A batchSize <= 0 would otherwise never advance the loop index, hanging
    // forever — this must fall back to the default instead of looping.
    it('falls back to the default batch size for a batchSize of 0, negative, or non-finite', () => {
        const input = [1, 2, 3];
        expect(chunkRecords(input, 0)).toEqual(chunkRecords(input, DEFAULT_USAGE_REPORT_BATCH_SIZE));
        expect(chunkRecords(input, -5)).toEqual(chunkRecords(input, DEFAULT_USAGE_REPORT_BATCH_SIZE));
        expect(chunkRecords(input, NaN)).toEqual(chunkRecords(input, DEFAULT_USAGE_REPORT_BATCH_SIZE));
    });
});

const oneRecord: any = {
    timestamp: 't', provider: 'gemini', callType: 'discovery',
    model: 'x', inputTokens: 1, outputTokens: 1, latencyMs: 1, costUsd: 0, success: true,
};

describe('reportUsage', () => {
    it('POSTs each batch with the expected URL/header/body', async () => {
        const fetchImpl = jest.fn<any>().mockResolvedValue({ ok: true, status: 200 });

        const result = await reportUsage([oneRecord, oneRecord, oneRecord], {
            url: 'https://gsr-code-review.fly.dev/api/usage/ingest',
            key: 'secret-key',
            repository: 'weitzer-org/logo-maker',
            batchSize: 2,
            fetchImpl: fetchImpl as any,
        });

        expect(result).toEqual({ batchesSent: 2, batchesFailed: 0 });
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        const [url, init] = fetchImpl.mock.calls[0] as [string, any];
        expect(url).toBe('https://gsr-code-review.fly.dev/api/usage/ingest');
        expect(init.method).toBe('POST');
        expect(init.headers['X-Usage-Ingest-Key']).toBe('secret-key');
        const body = JSON.parse(init.body);
        expect(body.repository).toBe('weitzer-org/logo-maker');
        expect(body.records).toHaveLength(2);
    });

    it('does not let one failed batch stop the rest, and never throws', async () => {
        const fetchImpl = jest.fn<any>()
            .mockResolvedValueOnce({ ok: false, status: 500 })
            .mockResolvedValueOnce({ ok: true, status: 200 });
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

        const result = await reportUsage([oneRecord, oneRecord], {
            url: 'https://example.test/ingest',
            key: 'k',
            batchSize: 1,
            fetchImpl: fetchImpl as any,
        });

        expect(result).toEqual({ batchesSent: 1, batchesFailed: 1 });
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        warnSpy.mockRestore();
    });

    it('treats a rejected fetch as a failed batch rather than throwing', async () => {
        const fetchImpl = jest.fn<any>().mockRejectedValue(new Error('network down'));
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

        await expect(
            reportUsage([oneRecord], { url: 'https://example.test/ingest', key: 'k', fetchImpl: fetchImpl as any })
        ).resolves.toEqual({ batchesSent: 0, batchesFailed: 1 });

        warnSpy.mockRestore();
    });
});
