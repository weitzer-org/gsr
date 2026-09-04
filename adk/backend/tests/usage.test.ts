import { jest, describe, it, expect, beforeAll, beforeEach } from '@jest/globals';
import { Readable } from 'stream';

const mockUploadJson = jest.fn<any>().mockResolvedValue(undefined);
const mockListFiles = jest.fn<any>();
const mockGetFileStream = jest.fn<any>();
const mockGetFileJson = jest.fn<any>();

// ESM modules are resolved/evaluated before a hoisted classic jest.mock()
// can apply, so — mirroring tests/evaluator.test.ts's proven pattern for
// this repo's ESM jest config — mock src/storage.js via
// jest.unstable_mockModule and dynamically import src/usage.js afterward,
// rather than a top-level `import` of the module under test.
jest.unstable_mockModule('../src/storage.js', () => ({
    uploadJson: mockUploadJson,
    listFiles: mockListFiles,
    getFileStream: mockGetFileStream,
    getFileJson: mockGetFileJson,
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

    it('prices gemini-3.8-flash at its introductory rate', () => {
        // Guards against the model silently falling through to the
        // unknown-model 0 branch, which would under-report spend rather
        // than error. Pinned to a date inside the introductory window so the
        // assertion keeps testing what it says once the rate lapses.
        const cost = usage.computeCostUsd('gemini-3.8-flash', 1_000_000, 1_000_000, 0, { at: new Date('2026-09-04T00:00:00Z') });
        expect(cost).toBeCloseTo(0.75 + 3.75, 5);
    });

    describe('scheduled rate changes', () => {
        // 3.6, 3.7 and 3.8 Flash are all on the same introductory rate,
        // doubling on 2027-01-01. Without a date-aware lookup every call
        // after that instant would keep billing the old rate, halving
        // reported spend with nothing to signal it.
        //
        // These two cases are also the integrity check on every scheduled
        // entry in PRICE_TABLE: a typo'd `supersededBy.from` fails to parse,
        // which pins the model to its current rate and breaks the
        // post-rollover assertion below. Add any newly scheduled model here.
        const SCHEDULED = ['gemini-3.6-flash', 'gemini-3.7-flash', 'gemini-3.8-flash'];

        it.each(SCHEDULED)('bills %s at the introductory rate up to the last instant before it lapses', (model) => {
            const cost = usage.computeCostUsd(model, 1_000_000, 1_000_000, 0, { at: new Date('2026-12-31T23:59:59.999Z') });
            expect(cost).toBeCloseTo(0.75 + 3.75, 5);
        });

        it.each(SCHEDULED)('bills %s at the standard rate from the moment it takes effect', (model) => {
            const cost = usage.computeCostUsd(model, 1_000_000, 1_000_000, 0, { at: new Date('2027-01-01T00:00:00Z') });
            expect(cost).toBeCloseTo(1.5 + 7.5, 5);
        });

        it('keeps applying the standard rate well after the change', () => {
            const cost = usage.computeCostUsd('gemini-3.8-flash', 1_000_000, 0, 0, { at: new Date('2028-06-01T00:00:00Z') });
            expect(cost).toBeCloseTo(1.5, 5);
        });

        it('leaves a model with no scheduled change unaffected by the call date', () => {
            const then = usage.computeCostUsd('gemini-3.1-pro-preview', 1_000_000, 0, 0, { at: new Date('2027-06-01T00:00:00Z') });
            expect(then).toBeCloseTo(usage.computeCostUsd('gemini-3.1-pro-preview', 1_000_000, 0), 8);
        });

        it('keeps the current rate when the call date is invalid', () => {
            // Any comparison against NaN is false, so an unguarded invalid
            // date reads as "past the change date" and bills the future rate.
            const cost = usage.computeCostUsd('gemini-3.8-flash', 1_000_000, 1_000_000, 0, { at: new Date('not a date') });
            expect(cost).toBeCloseTo(0.75 + 3.75, 5);
        });

        it('defaults to the rate in effect now when no date is given', () => {
            const now = usage.computeCostUsd('gemini-3.8-flash', 1_000_000, 1_000_000);
            const explicit = usage.computeCostUsd('gemini-3.8-flash', 1_000_000, 1_000_000, 0, { at: new Date() });
            expect(now).toBeCloseTo(explicit, 8);
        });
    });

    it('returns 0 for an unknown model rather than throwing', () => {
        expect(usage.computeCostUsd('some-future-model', 1000, 1000)).toBe(0);
    });

    it('does not bill thinking tokens on top of the fifth arg (avoids double-counting candidatesTokenCount)', () => {
        // The 5th parameter is now an options object ({ imageCount }), but a
        // stray token count passed there must still be ignored rather than
        // folded into the output rate.
        const cost = (usage.computeCostUsd as any)('gemini-3.1-pro-preview', 0, 0, 0, 1_000_000);
        expect(cost).toBe(0);
    });

    describe('image generation models', () => {
        // The Gemini image models are token-priced: resolution is carried in
        // candidatesTokenCount, so these assert the published per-image
        // prices fall out of the ordinary token math at the documented token
        // counts for each resolution.
        it.each([
            ['gemini-3.1-flash-image', 747, 0.045],  // standard tier throughout; batch is a flat 50% off both legs
            ['gemini-3.1-flash-image', 1120, 0.067],
            ['gemini-3.1-flash-image', 1680, 0.101],
            ['gemini-3.1-flash-image', 2520, 0.151],
            ['gemini-3.1-flash-lite-image', 1120, 0.0336],
            ['gemini-3-pro-image', 1120, 0.134],
            ['gemini-3-pro-image', 2000, 0.24],
        ])('prices %s at %i output tokens as ~$%f per image', (model, outputTokens, expected) => {
            expect(usage.computeCostUsd(model as string, 0, outputTokens as number)).toBeCloseTo(expected as number, 3);
        });

        it.each([
            ['imagen-4.0-fast-generate-001', 0.02],
            ['imagen-4.0-generate-001', 0.04],
            ['imagen-4.0-ultra-generate-001', 0.06],
        ])('bills %s per image regardless of token counts', (model, perImage) => {
            expect(usage.computeCostUsd(model as string, 0, 0, 0, { imageCount: 3 })).toBeCloseTo((perImage as number) * 3, 6);
        });

        it('defaults a per-image model to one image when the count is missing', () => {
            expect(usage.computeCostUsd('imagen-4.0-generate-001', 0, 0)).toBeCloseTo(0.04, 6);
        });

        it('honours an explicit zero-image count', () => {
            expect(usage.computeCostUsd('imagen-4.0-generate-001', 0, 0, 0, { imageCount: 0 })).toBe(0);
        });

        it('falls back to one image rather than NaN for a garbage count', () => {
            expect(usage.computeCostUsd('imagen-4.0-generate-001', 0, 0, 0, { imageCount: NaN })).toBeCloseTo(0.04, 6);
            expect(usage.computeCostUsd('imagen-4.0-generate-001', 0, 0, 0, { imageCount: -5 })).toBeCloseTo(0.04, 6);
        });

        it('ignores imageCount for token-priced models', () => {
            const withImages = usage.computeCostUsd('gemini-3.8-flash', 1_000_000, 0, 0, { imageCount: 10 });
            expect(withImages).toBeCloseTo(usage.computeCostUsd('gemini-3.8-flash', 1_000_000, 0), 8);
        });

        it('prices the image models from one billing tier, not a mix of two', () => {
            // Standard tier on both legs. Pairing Flash Image's batch input
            // ($0.25) with its standard image output ($60) would price
            // neither tier correctly.
            expect(usage.computeCostUsd('gemini-3.1-flash-image', 1_000_000, 0)).toBeCloseTo(0.5, 6);
            expect(usage.computeCostUsd('gemini-3.1-flash-lite-image', 1_000_000, 0)).toBeCloseTo(0.25, 6);
            expect(usage.computeCostUsd('gemini-3-pro-image', 1_000_000, 0)).toBeCloseTo(2.0, 6);
        });

        it('does not charge Imagen for its prompt tokens, which are bundled into the per-image price', () => {
            const withPrompt = usage.computeCostUsd('imagen-4.0-generate-001', 480, 0, 0, { imageCount: 1 });
            expect(withPrompt).toBeCloseTo(0.04, 6);
        });
    });
});

describe('countGeneratedImages', () => {
    it('counts inline image parts on a generateContent response', () => {
        expect(usage.countGeneratedImages({
            candidates: [{ content: { parts: [
                { inlineData: { mimeType: 'image/png' } },
                { inlineData: { mimeType: 'image/jpeg' } },
            ] } }],
        })).toBe(2);
    });

    it('counts an Imagen generateImages response', () => {
        expect(usage.countGeneratedImages({ generatedImages: [{}, {}, {}] })).toBe(3);
    });

    it('reports 0 for an empty generatedImages array rather than undefined', () => {
        // undefined here would mean "no count available", which
        // computeCostUsd defaults to one image — billing $0.04 for a
        // generation that produced nothing.
        expect(usage.countGeneratedImages({ generatedImages: [] })).toBe(0);
        expect(usage.computeCostUsd('imagen-4.0-generate-001', 0, 0, 0, { imageCount: 0 })).toBe(0);
    });

    it('returns undefined for an ordinary text response so the field stays absent', () => {
        expect(usage.countGeneratedImages({ candidates: [{ finishReason: 'STOP' }] })).toBeUndefined();
        expect(usage.countGeneratedImages({})).toBeUndefined();
    });

    it('counts image parts whatever the case of the MIME type', () => {
        // RFC 2045 makes media types case-insensitive; an uncounted image is
        // an unbilled one.
        expect(usage.countGeneratedImages({
            candidates: [{ content: { parts: [{ inlineData: { mimeType: 'Image/PNG' } }, { inlineData: { mimeType: 'IMAGE/jpeg' } }] } }],
        })).toBe(2);
    });

    it('ignores non-image inline parts', () => {
        expect(usage.countGeneratedImages({
            candidates: [{ content: { parts: [{ inlineData: { mimeType: 'application/pdf' } }, {}] } }],
        })).toBeUndefined();
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

    it('records imageCount and per-image cost for an Imagen call', async () => {
        // Imagen reports no usageMetadata at all — the image count is the
        // only billable signal, so it must survive onto the record.
        const response = { generatedImages: [{}, {}] };
        await usage.trackGeminiCall({ callType: 'logo', model: 'imagen-4.0-generate-001' }, () => Promise.resolve(response));

        const [, , data] = mockUploadJson.mock.calls[0] as [string, string, any];
        expect(data.imageCount).toBe(2);
        expect(data.costUsd).toBeCloseTo(0.08, 6);
    });

    it('leaves imageCount absent on an ordinary text call', async () => {
        const response = { text: 'ok', usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 10 } };
        await usage.trackGeminiCall({ callType: 'legacy', model: 'gemini-3.8-flash' }, () => Promise.resolve(response));

        const [, , data] = mockUploadJson.mock.calls[0] as [string, string, any];
        expect(data.imageCount).toBeUndefined();
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

    it('records thinking tokens from thoughtsTokenCount as telemetry, without folding them into cost', async () => {
        const response = { text: 'ok', usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 10, thoughtsTokenCount: 30 } };
        await usage.trackGeminiCall({ callType: 'legacy', model: 'gemini-3.1-pro-preview' }, () => Promise.resolve(response));

        const [, , data] = mockUploadJson.mock.calls[0] as [string, string, any];
        expect(data.thinkingTokens).toBe(30);
        // costUsd reflects only inputTokens/outputTokens — candidatesTokenCount
        // (outputTokens) already reflects thinking tokens per Gemini's own
        // pricing docs, so thinkingTokens must not be billed a second time.
        expect(data.costUsd).toBeCloseTo(usage.computeCostUsd('gemini-3.1-pro-preview', 50, 10, 0), 8);
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

describe('recordParseFailure', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockUploadJson.mockResolvedValue(undefined);
    });

    it('records a failure with costUsd 0 to avoid double-billing an already-tracked call', async () => {
        const response = { text: '{not valid json', usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 10, thoughtsTokenCount: 5 } };
        await usage.recordParseFailure({ callType: 'discovery', model: 'gemini-3.1-pro-preview' }, response, 123);

        expect(mockUploadJson).toHaveBeenCalledTimes(1);
        const [, , data] = mockUploadJson.mock.calls[0] as [string, string, any];
        expect(data.success).toBe(false);
        expect(data.errorKind).toBe('parse_error');
        expect(data.costUsd).toBe(0);
        // Token counts are still preserved for diagnosis even though cost is
        // zeroed — e.g. distinguishing a MAX_TOKENS truncation from a
        // genuinely malformed response.
        expect(data.inputTokens).toBe(50);
        expect(data.outputTokens).toBe(10);
        expect(data.thinkingTokens).toBe(5);
        expect(data.latencyMs).toBe(123);
    });

    it('captures finishReason and defaults token counts to 0 with no usageMetadata', async () => {
        const response = { candidates: [{ finishReason: 'MAX_TOKENS' }] };
        await usage.recordParseFailure({ callType: 'remediation', model: 'x' }, response, 0);

        const [, , data] = mockUploadJson.mock.calls[0] as [string, string, any];
        expect(data.finishReason).toBe('MAX_TOKENS');
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

    it('defaults an untagged record to the "gsr (hosted)" repository bucket, and passes through a tagged one', () => {
        const records: Array<Record<string, unknown>> = [
            { timestamp: 't', provider: 'gemini', callType: 'discovery', model: 'x', inputTokens: 1, outputTokens: 1, latencyMs: 1, costUsd: 0, success: true },
            { timestamp: 't', provider: 'gemini', callType: 'discovery', model: 'x', inputTokens: 1, outputTokens: 1, latencyMs: 1, costUsd: 0, success: true, repository: 'weitzer-org/logo-maker' },
        ];
        const rollup = usage.aggregate('2026-07-29', records as any);
        expect(rollup.byRepository['gsr (hosted)'].calls).toBe(1);
        expect(rollup.byRepository['weitzer-org/logo-maker'].calls).toBe(1);
    });

    it('splits by workload: "evaluate" callType is eval, everything else is review', () => {
        const records: Array<Record<string, unknown>> = [
            { timestamp: 't', provider: 'gemini', callType: 'evaluate', model: 'x', inputTokens: 1, outputTokens: 1, latencyMs: 1, costUsd: 0, success: true },
            { timestamp: 't', provider: 'gemini', callType: 'discovery', model: 'x', inputTokens: 1, outputTokens: 1, latencyMs: 1, costUsd: 0, success: true },
            { timestamp: 't', provider: 'gemini', callType: 'deduplicate', model: 'x', inputTokens: 1, outputTokens: 1, latencyMs: 1, costUsd: 0, success: true },
        ];
        const rollup = usage.aggregate('2026-07-29', records as any);
        expect(rollup.byWorkload['eval'].calls).toBe(1);
        expect(rollup.byWorkload['review'].calls).toBe(2);
    });

    it('classifies an unrecognized callType (job_tracker/sound-profile-builder\'s own native usage) as "product"', () => {
        const records: Array<Record<string, unknown>> = [
            // job_tracker's own fixed CallType vocabulary — not review, not eval.
            { timestamp: 't', provider: 'gemini', callType: 'score_job', model: 'gemini-3.1-pro-preview', inputTokens: 1, outputTokens: 1, latencyMs: 1, costUsd: 0, success: true, repository: 'weitzer-org/job_tracker' },
            // sound-profile-builder's callType is a free-text agent role, not an enum.
            { timestamp: 't', provider: 'gemini', callType: 'Tone Historian', model: 'gemini-3.1-pro-preview', inputTokens: 1, outputTokens: 1, latencyMs: 1, costUsd: 0, success: true, repository: 'weitzer-org/sound-profile-builder' },
        ];
        const rollup = usage.aggregate('2026-07-29', records as any);
        expect(rollup.byWorkload['product'].calls).toBe(2);
        expect(rollup.byWorkload['eval']).toBeUndefined();
        expect(rollup.byWorkload['review']).toBeUndefined();
    });

    it('classifies tools/eval\'s llm_compare* callTypes as eval workload too', () => {
        const records: Array<Record<string, unknown>> = [
            { timestamp: 't', provider: 'gemini', callType: 'llm_compare', model: 'gemini-2.5-pro', inputTokens: 1, outputTokens: 1, latencyMs: 1, costUsd: 0, success: true, repository: 'tools-eval (local)' },
            { timestamp: 't', provider: 'gemini', callType: 'llm_compare_v2_aggregate', model: 'gemini-2.5-pro', inputTokens: 1, outputTokens: 1, latencyMs: 1, costUsd: 0, success: true, repository: 'tools-eval (local)' },
        ];
        const rollup = usage.aggregate('2026-07-29', records as any);
        expect(rollup.byWorkload['eval'].calls).toBe(2);
        expect(rollup.byRepository['tools-eval (local)'].calls).toBe(2);
    });

    it('builds the model x repository intersection keyed on "model|repository"', () => {
        const records: Array<Record<string, unknown>> = [
            { timestamp: 't', provider: 'gemini', callType: 'discovery', model: 'gemini-3.1-pro-preview', inputTokens: 1, outputTokens: 1, latencyMs: 1, costUsd: 0, success: true, repository: 'weitzer-org/logo-maker' },
            { timestamp: 't', provider: 'gemini', callType: 'discovery', model: 'gemini-3.1-pro-preview', inputTokens: 1, outputTokens: 1, latencyMs: 1, costUsd: 0, success: true },
        ];
        const rollup = usage.aggregate('2026-07-29', records as any);
        expect(rollup.byModelRepository['gemini-3.1-pro-preview|weitzer-org/logo-maker'].calls).toBe(1);
        expect(rollup.byModelRepository['gemini-3.1-pro-preview|gsr (hosted)'].calls).toBe(1);
    });

    it('sums thinkingTokens into totals and per-bucket', () => {
        const records: Array<Record<string, unknown>> = [
            { timestamp: 't', provider: 'gemini', callType: 'discovery', model: 'x', inputTokens: 1, outputTokens: 1, thinkingTokens: 40, latencyMs: 1, costUsd: 0, success: true },
        ];
        const rollup = usage.aggregate('2026-07-29', records as any);
        expect(rollup.totalThinkingTokens).toBe(40);
        expect(rollup.byModel['x'].thinkingTokens).toBe(40);
    });

    it('stamps the current schemaVersion', () => {
        const rollup = usage.aggregate('2026-07-29', []);
        expect(rollup.schemaVersion).toBe(usage.CURRENT_SCHEMA_VERSION);
    });

    it('does not pollute Object.prototype when a record field is literally "__proto__"', () => {
        const before = (Object.prototype as any).calls;
        const records: Array<Record<string, unknown>> = [
            { timestamp: 't', provider: 'gemini', callType: '__proto__', model: '__proto__', inputTokens: 1, outputTokens: 1, latencyMs: 1, costUsd: 0, success: true, repository: '__proto__' },
        ];
        usage.aggregate('2026-07-29', records as any);
        expect((Object.prototype as any).calls).toBe(before);
        expect(Object.keys({})).toHaveLength(0);
    });

    it('does not silently drop/miscount an errorKind of literally "__proto__"', () => {
        const records: Array<Record<string, unknown>> = [
            { timestamp: 't', provider: 'gemini', callType: 'discovery', model: 'x', inputTokens: 0, outputTokens: 0, latencyMs: 1, costUsd: 0, success: false, errorKind: '__proto__' },
            { timestamp: 't', provider: 'gemini', callType: 'discovery', model: 'x', inputTokens: 0, outputTokens: 0, latencyMs: 1, costUsd: 0, success: false, errorKind: 'rate_limit' },
        ];
        const rollup = usage.aggregate('2026-07-29', records as any);
        // The unsafe key is skipped entirely rather than silently coerced
        // into a garbled/no-op'd entry — a legitimate key alongside it still
        // counts normally.
        expect(Object.keys(rollup.byErrorKind)).not.toContain('__proto__');
        expect(rollup.byErrorKind['rate_limit']).toBe(1);
    });
});

describe('sumRollups', () => {
    it('sums additive fields and merges bucket maps across rollups', () => {
        const a = usage.aggregate('2026-07-28', [
            { timestamp: 't', provider: 'gemini', callType: 'discovery', model: 'x', inputTokens: 10, outputTokens: 5, latencyMs: 100, costUsd: 0.01, success: true } as any,
        ]);
        const b = usage.aggregate('2026-07-29', [
            { timestamp: 't', provider: 'gemini', callType: 'discovery', model: 'x', inputTokens: 20, outputTokens: 10, latencyMs: 300, costUsd: 0.02, success: true } as any,
        ]);

        const summed = usage.sumRollups('2026-W31', [a, b]);
        expect(summed.totalCalls).toBe(2);
        expect(summed.totalInputTokens).toBe(30);
        expect(summed.byModel['x'].calls).toBe(2);
        expect(summed.avgLatencyMs).toBeCloseTo((100 + 300) / 2, 5);
        expect(summed.date).toBe('2026-W31');
    });

    it('returns a zero-value rollup for an empty list', () => {
        const summed = usage.sumRollups('empty', []);
        expect(summed.totalCalls).toBe(0);
        expect(summed.avgLatencyMs).toBe(0);
    });
});

describe('getOrBuildDayRollup', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockUploadJson.mockResolvedValue(undefined);
    });

    it("always recomputes today's rollup and never reads or writes the cache", async () => {
        mockListFiles.mockResolvedValue([]);
        const rollup = await usage.getOrBuildDayRollup('2026-07-29', '2026-07-29');
        expect(mockGetFileJson).not.toHaveBeenCalled();
        expect(mockUploadJson).not.toHaveBeenCalled();
        expect(rollup.date).toBe('2026-07-29');
    });

    it('never caches a future date — an empty rollup for it would otherwise permanently mask real data once that date arrives', async () => {
        mockListFiles.mockResolvedValue([]);
        const rollup = await usage.getOrBuildDayRollup('2026-07-30', '2026-07-29');
        expect(mockGetFileJson).not.toHaveBeenCalled();
        expect(mockUploadJson).not.toHaveBeenCalled();
        expect(rollup.date).toBe('2026-07-30');
    });

    it('serves a cached past-day rollup at the current schema version without recomputing', async () => {
        const cached = usage.aggregate('2026-07-28', []);
        mockGetFileJson.mockResolvedValue(cached);

        const rollup = await usage.getOrBuildDayRollup('2026-07-28', '2026-07-29');
        expect(rollup).toBe(cached);
        expect(mockListFiles).not.toHaveBeenCalled();
    });

    it('rebuilds and overwrites a stale-schema cached rollup for a past day', async () => {
        mockGetFileJson.mockResolvedValue({ date: '2026-07-28', schemaVersion: 1 });
        mockListFiles.mockResolvedValue([]);

        const rollup = await usage.getOrBuildDayRollup('2026-07-28', '2026-07-29');
        expect(rollup.schemaVersion).toBe(usage.CURRENT_SCHEMA_VERSION);
        expect(mockUploadJson).toHaveBeenCalledTimes(1);
        const [, key] = mockUploadJson.mock.calls[0] as [string, string, any];
        expect(key).toBe('usage/rollups/2026-07-28.json');
    });

    it('rebuilds a missing cached rollup for a past day', async () => {
        mockGetFileJson.mockResolvedValue(undefined);
        mockListFiles.mockResolvedValue([]);

        const rollup = await usage.getOrBuildDayRollup('2026-07-28', '2026-07-29');
        expect(rollup.totalCalls).toBe(0);
        expect(mockUploadJson).toHaveBeenCalledTimes(1);
    });

    it('reads/writes an explicit bucket override instead of the default S3_REVIEW_BUCKET', async () => {
        mockGetFileJson.mockResolvedValue(undefined);
        mockListFiles.mockResolvedValue([]);

        await usage.getOrBuildDayRollup('2026-07-28', '2026-07-29', 'gsr-eval-results');
        expect(mockGetFileJson).toHaveBeenCalledWith('gsr-eval-results', 'usage/rollups/2026-07-28.json');
        expect(mockListFiles).toHaveBeenCalledWith('gsr-eval-results', 'usage/2026-07-28/');
        const [bucket] = mockUploadJson.mock.calls[0] as [string, string, any];
        expect(bucket).toBe('gsr-eval-results');
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

    it('keys the stored object under the record\'s OWN timestamp, not today — critical for a historical backfill to land on the right date', async () => {
        const historical = { ...record('score_job'), timestamp: '2026-01-15T10:00:00.000Z' };
        await usage.ingestUsageRecords([historical] as any, { repository: 'weitzer-org/job_tracker' });
        const [, key] = mockUploadJson.mock.calls[0] as [string, string, any];
        expect(key).toMatch(/^usage\/2026-01-15\//);
        expect(key).not.toMatch(new RegExp(`^usage\\/${usage.currentDateString()}\\/`));
    });

    it('falls back to today\'s date when a record has an unparsable timestamp, logging a warning instead of dropping it', async () => {
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const bad = { ...record('discovery'), timestamp: 'not-a-real-timestamp' };

        const result = await usage.ingestUsageRecords([bad] as any);

        expect(result).toEqual({ accepted: 1, failed: 0 });
        const [, key] = mockUploadJson.mock.calls[0] as [string, string, any];
        expect(key).toMatch(new RegExp(`^usage\\/${usage.currentDateString()}\\/`));
        expect(warnSpy).toHaveBeenCalled();
        warnSpy.mockRestore();
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
            { ...record('discovery'), thinkingTokens: 'not-a-number' },
        ];

        const result = await usage.ingestUsageRecords(malformed as any);

        expect(result).toEqual({ accepted: 0, failed: malformed.length });
        expect(mockUploadJson).not.toHaveBeenCalled();
        errorSpy.mockRestore();
    });

    it('accepts a record with a numeric thinkingTokens', async () => {
        const result = await usage.ingestUsageRecords([{ ...record('discovery'), thinkingTokens: 15 }] as any);
        expect(result).toEqual({ accepted: 1, failed: 0 });
    });

    it('rejects a record whose model contains the "|" composite-key delimiter', async () => {
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        const result = await usage.ingestUsageRecords([{ ...record('discovery'), model: 'evil|model' }] as any);
        expect(result).toEqual({ accepted: 0, failed: 1 });
        expect(mockUploadJson).not.toHaveBeenCalled();
        errorSpy.mockRestore();
    });

    it('rejects a record whose own repository field contains "|"', async () => {
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        const result = await usage.ingestUsageRecords([{ ...record('discovery'), repository: 'owner|repo' }] as any);
        expect(result).toEqual({ accepted: 0, failed: 1 });
        errorSpy.mockRestore();
    });

    it('drops (rather than rejects the whole batch for) a batch-level repository containing "|"', async () => {
        const result = await usage.ingestUsageRecords([record('discovery')], { repository: 'owner|repo' });
        expect(result).toEqual({ accepted: 1, failed: 0 });
        const [, , data] = mockUploadJson.mock.calls[0] as [string, string, any];
        expect(data.repository).toBeUndefined();
    });

    it('rejects a record whose errorKind is an unsafe key like "__proto__"', async () => {
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        const result = await usage.ingestUsageRecords([{ ...record('discovery'), errorKind: '__proto__' }] as any);
        expect(result).toEqual({ accepted: 0, failed: 1 });
        errorSpy.mockRestore();
    });

    it('rejects a record with a negative cachedTokens', async () => {
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        const result = await usage.ingestUsageRecords([{ ...record('discovery'), cachedTokens: -1 }] as any);
        expect(result).toEqual({ accepted: 0, failed: 1 });
        errorSpy.mockRestore();
    });

    it('rejects a record whose imageCount is negative, fractional, non-finite, or not a number', async () => {
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        const cases = [
            { ...record('discovery'), imageCount: -1 },
            { ...record('discovery'), imageCount: NaN },
            { ...record('discovery'), imageCount: Infinity },
            { ...record('discovery'), imageCount: '2' },
            { ...record('discovery'), imageCount: 0.5 },
        ];
        for (const bad of cases) {
            expect(await usage.ingestUsageRecords([bad] as any)).toEqual({ accepted: 0, failed: 1 });
        }
        errorSpy.mockRestore();
    });

    it('accepts a record with a valid imageCount, and one with none at all', async () => {
        const withCount = await usage.ingestUsageRecords([{ ...record('image'), imageCount: 3 }] as any);
        expect(withCount).toEqual({ accepted: 1, failed: 0 });
        const without = await usage.ingestUsageRecords([record('discovery')]);
        expect(without).toEqual({ accepted: 1, failed: 0 });
    });

    it('rejects a record with negative inputTokens, outputTokens, latencyMs, or costUsd', async () => {
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        const cases = [
            { ...record('discovery'), inputTokens: -1 },
            { ...record('discovery'), outputTokens: -1 },
            { ...record('discovery'), latencyMs: -1 },
            { ...record('discovery'), costUsd: -1 },
        ];
        const result = await usage.ingestUsageRecords(cases as any);
        expect(result).toEqual({ accepted: 0, failed: cases.length });
        errorSpy.mockRestore();
    });

    it('accepts a record with a valid errorKind and cachedTokens', async () => {
        const result = await usage.ingestUsageRecords([{ ...record('discovery'), errorKind: 'rate_limit', cachedTokens: 50, success: false }] as any);
        expect(result).toEqual({ accepted: 1, failed: 0 });
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

    it('lists against an explicit bucket override instead of the default S3_REVIEW_BUCKET', async () => {
        mockListFiles.mockResolvedValue([]);
        await usage.listUsageRecords('2026-07-29', 'gsr-eval-results');
        expect(mockListFiles).toHaveBeenCalledWith('gsr-eval-results', 'usage/2026-07-29/');
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
