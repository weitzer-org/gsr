import { jest, describe, it, expect, beforeAll, beforeEach } from '@jest/globals';
import { Readable } from 'stream';

const mockUploadJson = jest.fn<any>().mockResolvedValue(undefined);
const mockListFiles = jest.fn<any>();
const mockGetFileStream = jest.fn<any>();

// ESM modules are resolved/evaluated before a hoisted classic jest.mock()
// can apply, so — mirroring tests/evaluator.test.ts's proven pattern for
// this repo's ESM jest config — mock src/storage.js via
// jest.unstable_mockModule and dynamically import src/usage.js afterward,
// rather than a top-level `import` of the module under test.
jest.unstable_mockModule('../src/storage.js', () => ({
    uploadJson: mockUploadJson,
    listFiles: mockListFiles,
    getFileStream: mockGetFileStream,
}));

let usage: typeof import('../src/usage.js');

beforeAll(async () => {
    usage = await import('../src/usage.js');
});

describe('computeCostUsd', () => {
    it('computes cost for a known model', () => {
        const cost = usage.computeCostUsd('gemini-3.1-pro-preview', 1_000_000, 1_000_000);
        expect(cost).toBeCloseTo(2.0 + 12.0, 5);
    });

    it('subtracts cached tokens from the billed input count', () => {
        const withCache = usage.computeCostUsd('gemini-3.1-pro-preview', 1_000_000, 0, 500_000);
        const withoutCache = usage.computeCostUsd('gemini-3.1-pro-preview', 500_000, 0);
        expect(withCache).toBeCloseTo(withoutCache, 5);
    });

    it('returns 0 for an unknown model rather than throwing', () => {
        expect(usage.computeCostUsd('some-future-model', 1000, 1000)).toBe(0);
    });
});

describe('classifyError', () => {
    it('classifies a 429 status as rate_limit', () => {
        expect(usage.classifyError({ status: 429 })).toBe('rate_limit');
    });

    it('classifies a 401/403 status as auth', () => {
        expect(usage.classifyError({ status: 401 })).toBe('auth');
        expect(usage.classifyError({ status: 403 })).toBe('auth');
    });

    it('classifies a 5xx status as unavailable', () => {
        expect(usage.classifyError({ status: 503 })).toBe('unavailable');
    });

    it('classifies an ETIMEDOUT message as timeout', () => {
        expect(usage.classifyError(new Error('ETIMEDOUT: Gemini fetch exceeded 180000ms.'))).toBe('timeout');
    });

    it('falls back to api_error for anything unrecognized', () => {
        expect(usage.classifyError(new Error('some unrelated SDK failure'))).toBe('api_error');
    });
});

describe('recordUsage', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockUploadJson.mockResolvedValue(undefined);
    });

    it('uploads a record with the expected shape', async () => {
        await usage.recordUsage({
            callType: 'discovery',
            model: 'gemini-3.1-pro-preview',
            inputTokens: 100,
            outputTokens: 20,
            latencyMs: 1234,
            costUsd: 0.001,
            success: true,
        });

        expect(mockUploadJson).toHaveBeenCalledTimes(1);
        const [bucket, key, data] = mockUploadJson.mock.calls[0] as [string, string, any];
        expect(bucket).toBeTruthy();
        expect(key).toMatch(/^usage\/\d{4}-\d{2}-\d{2}\/\d{9}-[0-9a-f]{8}\.json$/);
        expect(data.provider).toBe('gemini');
        expect(data.callType).toBe('discovery');
        expect(data.inputTokens).toBe(100);
        expect(typeof data.timestamp).toBe('string');
    });

    it('never throws when the upload fails', async () => {
        mockUploadJson.mockRejectedValueOnce(new Error('network down'));
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

        await expect(
            usage.recordUsage({ callType: 'discovery', model: 'x', inputTokens: 0, outputTokens: 0, latencyMs: 0, costUsd: 0, success: true })
        ).resolves.toBeUndefined();

        expect(errorSpy).toHaveBeenCalled();
        errorSpy.mockRestore();
    });
});

describe('trackGeminiCall', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockUploadJson.mockResolvedValue(undefined);
    });

    it('records a successful call and returns the response unchanged', async () => {
        const response = { text: 'ok', usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 10 } };
        const result = await usage.trackGeminiCall({ callType: 'legacy', model: 'gemini-3.1-pro-preview' }, () => Promise.resolve(response));

        expect(result).toBe(response);
        expect(mockUploadJson).toHaveBeenCalledTimes(1);
        const [, , data] = mockUploadJson.mock.calls[0] as [string, string, any];
        expect(data.success).toBe(true);
        expect(data.inputTokens).toBe(50);
        expect(data.outputTokens).toBe(10);
    });

    it('records a failed call with a classified errorKind and rethrows unchanged', async () => {
        const original = Object.assign(new Error('boom'), { status: 429 });
        await expect(
            usage.trackGeminiCall({ callType: 'discovery', model: 'gemini-3.1-pro-preview' }, () => Promise.reject(original))
        ).rejects.toBe(original);

        expect(mockUploadJson).toHaveBeenCalledTimes(1);
        const [, , data] = mockUploadJson.mock.calls[0] as [string, string, any];
        expect(data.success).toBe(false);
        expect(data.errorKind).toBe('rate_limit');
        expect(data.inputTokens).toBe(0);
    });

    it('handles a response with no usageMetadata as zero tokens, still success', async () => {
        const result = await usage.trackGeminiCall({ callType: 'legacy', model: 'x' }, () => Promise.resolve({ text: 'ok' } as any));
        expect((result as any).text).toBe('ok');
        const [, , data] = mockUploadJson.mock.calls[0] as [string, string, any];
        expect(data.success).toBe(true);
        expect(data.inputTokens).toBe(0);
        expect(data.outputTokens).toBe(0);
    });
});

describe('aggregate', () => {
    it('returns a zero-value rollup for no records', () => {
        const rollup = usage.aggregate('2026-07-29', []);
        expect(rollup.totalCalls).toBe(0);
        expect(rollup.avgLatencyMs).toBe(0);
    });

    it('sums totals and breaks down by callType/model/errorKind', () => {
        const records: Array<Record<string, unknown>> = [
            { timestamp: 't', provider: 'gemini', callType: 'discovery', model: 'gemini-3.1-pro-preview', inputTokens: 100, outputTokens: 20, latencyMs: 1000, costUsd: 0.01, success: true },
            { timestamp: 't', provider: 'gemini', callType: 'discovery', model: 'gemini-3.1-pro-preview', inputTokens: 200, outputTokens: 40, latencyMs: 3000, costUsd: 0.02, success: true },
            { timestamp: 't', provider: 'gemini', callType: 'discovery', model: 'gemini-3.1-pro-preview', inputTokens: 0, outputTokens: 0, latencyMs: 500, costUsd: 0, success: false, errorKind: 'rate_limit' },
            { timestamp: 't', provider: 'gemini', callType: 'deduplicate', model: 'gemini-3.5-flash', inputTokens: 50, outputTokens: 10, latencyMs: 500, costUsd: 0.001, success: true },
        ];

        const rollup = usage.aggregate('2026-07-29', records as any);

        expect(rollup.totalCalls).toBe(4);
        expect(rollup.successCount).toBe(3);
        expect(rollup.failureCount).toBe(1);
        expect(rollup.totalInputTokens).toBe(350);
        expect(rollup.totalOutputTokens).toBe(70);
        expect(rollup.byErrorKind['rate_limit']).toBe(1);
        expect(rollup.byCallType['discovery'].calls).toBe(3);
        expect(rollup.byCallType['discovery'].successCount).toBe(2);
        expect(rollup.byCallType['discovery'].failureCount).toBe(1);
        expect(rollup.byModel['gemini-3.5-flash'].calls).toBe(1);
        expect(rollup.avgLatencyMs).toBeCloseTo((1000 + 3000 + 500 + 500) / 4, 5);
    });
});

describe('setUsageSink / resetUsageSink', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockUploadJson.mockResolvedValue(undefined);
    });

    afterEach(() => {
        // sink is module-global state — leaking an override here would
        // silently break the recordUsage/trackGeminiCall describe blocks
        // above and below, which assert mockUploadJson is called directly.
        usage.resetUsageSink();
    });

    it('redirects recordUsage to a custom sink instead of uploadJson', async () => {
        const received: any[] = [];
        usage.setUsageSink(record => { received.push(record); });

        await usage.recordUsage({
            callType: 'discovery',
            model: 'gemini-3.1-pro-preview',
            inputTokens: 10,
            outputTokens: 5,
            latencyMs: 100,
            costUsd: 0,
            success: true,
        });

        expect(mockUploadJson).not.toHaveBeenCalled();
        expect(received).toHaveLength(1);
        expect(received[0].callType).toBe('discovery');
    });

    it('resetUsageSink restores the default S3-writing sink', async () => {
        usage.setUsageSink(() => {});
        usage.resetUsageSink();

        await usage.recordUsage({
            callType: 'discovery',
            model: 'x',
            inputTokens: 0,
            outputTokens: 0,
            latencyMs: 0,
            costUsd: 0,
            success: true,
        });

        expect(mockUploadJson).toHaveBeenCalledTimes(1);
    });
});

describe('ingestUsageRecords', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockUploadJson.mockResolvedValue(undefined);
    });

    const record = (callType: string) => ({
        timestamp: 't', provider: 'gemini' as const, callType, model: 'x',
        inputTokens: 1, outputTokens: 1, latencyMs: 1, costUsd: 0, success: true,
    });

    it('writes one object per record and reports accepted/failed counts', async () => {
        const result = await usage.ingestUsageRecords([record('discovery'), record('deduplicate')]);
        expect(mockUploadJson).toHaveBeenCalledTimes(2);
        expect(result).toEqual({ accepted: 2, failed: 0 });
    });

    it('tags each persisted record with the given repository', async () => {
        await usage.ingestUsageRecords([record('discovery')], { repository: 'weitzer-org/logo-maker' });
        const [, , data] = mockUploadJson.mock.calls[0] as [string, string, any];
        expect(data.repository).toBe('weitzer-org/logo-maker');
    });

    it('skips a record whose write fails instead of throwing, and reflects it in failed count', async () => {
        mockUploadJson.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('network down'));
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

        const result = await usage.ingestUsageRecords([record('discovery'), record('deduplicate')]);

        expect(result).toEqual({ accepted: 1, failed: 1 });
        errorSpy.mockRestore();
    });

    it('rejects a malformed record instead of writing it verbatim', async () => {
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

        const malformed = [
            null,
            'not-an-object',
            { ...record('discovery'), inputTokens: 'not-a-number' },
            { ...record('discovery'), provider: 'openai' },
            { ...record('discovery'), success: 'true' },
        ];

        const result = await usage.ingestUsageRecords(malformed as any);

        expect(result).toEqual({ accepted: 0, failed: malformed.length });
        expect(mockUploadJson).not.toHaveBeenCalled();
        errorSpy.mockRestore();
    });
});

describe('formatUsageSummaryMarkdown', () => {
    it('renders totals and a per-call-type breakdown', () => {
        const rollup = usage.aggregate('2026-07-29', [
            { timestamp: 't', provider: 'gemini', callType: 'discovery', model: 'gemini-3.1-pro-preview', inputTokens: 100, outputTokens: 20, latencyMs: 1000, costUsd: 0.01, success: true } as any,
            { timestamp: 't', provider: 'gemini', callType: 'discovery', model: 'gemini-3.1-pro-preview', inputTokens: 0, outputTokens: 0, latencyMs: 500, costUsd: 0, success: false, errorKind: 'rate_limit' } as any,
        ]);

        const md = usage.formatUsageSummaryMarkdown(rollup);

        expect(md).toContain('## GSR Usage Summary');
        expect(md).toContain('| 2 | 1 | 1 |');
        expect(md).toContain('### By call type');
        expect(md).toContain('discovery');
        expect(md).toContain('### Errors');
        expect(md).toContain('rate_limit');
    });

    it('omits the errors section when there are no failures', () => {
        const rollup = usage.aggregate('2026-07-29', []);
        expect(usage.formatUsageSummaryMarkdown(rollup)).not.toContain('### Errors');
    });
});

describe('listUsageRecords', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('reads and decodes every file under the date prefix', async () => {
        mockListFiles.mockResolvedValue([{ name: 'usage/2026-07-29/1-aaaa.json' }, { name: 'usage/2026-07-29/2-bbbb.json' }]);
        const rec1 = { timestamp: 't', provider: 'gemini', callType: 'discovery', model: 'x', inputTokens: 1, outputTokens: 1, latencyMs: 1, costUsd: 0, success: true };
        const rec2 = { ...rec1, callType: 'deduplicate' };
        mockGetFileStream
            .mockResolvedValueOnce(Readable.from([JSON.stringify(rec1)]))
            .mockResolvedValueOnce(Readable.from([JSON.stringify(rec2)]));

        const records = await usage.listUsageRecords('2026-07-29');
        expect(records).toHaveLength(2);
        expect(records.map(r => r.callType).sort()).toEqual(['deduplicate', 'discovery']);
    });

    it('skips a record that fails to read/parse instead of throwing', async () => {
        mockListFiles.mockResolvedValue([{ name: 'usage/2026-07-29/bad.json' }, { name: 'usage/2026-07-29/good.json' }]);
        const good = { timestamp: 't', provider: 'gemini', callType: 'discovery', model: 'x', inputTokens: 1, outputTokens: 1, latencyMs: 1, costUsd: 0, success: true };
        mockGetFileStream
            .mockRejectedValueOnce(new Error('not found'))
            .mockResolvedValueOnce(Readable.from([JSON.stringify(good)]));
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

        const records = await usage.listUsageRecords('2026-07-29');
        expect(records).toHaveLength(1);
        expect(records[0].callType).toBe('discovery');
        errorSpy.mockRestore();
    });
});
