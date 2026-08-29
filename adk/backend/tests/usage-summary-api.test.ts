import { jest, expect, describe, it, beforeAll, beforeEach, afterEach } from '@jest/globals';
import request from 'supertest';

const listFilesMock = jest.fn<any>();
const getFileStreamMock = jest.fn<any>();
const uploadJsonMock = jest.fn<any>();
const getFileJsonMock = jest.fn<any>();

jest.unstable_mockModule('../src/storage.js', () => ({
    uploadJson: uploadJsonMock,
    listFiles: listFilesMock,
    getFileStream: getFileStreamMock,
    getFileJson: getFileJsonMock,
}));

// Exercises the real app.ts wiring end-to-end (route placement relative to
// requireAuth, query validation, the getOrBuildDayRollup/sumRollups plumbing),
// the same way usage-ingest-integration.test.ts does for the write side.
describe('GET /api/usage/summary (integration, real app wiring)', () => {
    let app: any;
    const originalReviewBucket = process.env.S3_REVIEW_BUCKET;
    const originalEvalBucket = process.env.S3_BUCKET;

    beforeAll(() => {
        jest.spyOn(console, 'error').mockImplementation(() => {});
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        jest.spyOn(console, 'log').mockImplementation(() => {});
    });

    beforeEach(async () => {
        jest.resetModules();
        listFilesMock.mockReset().mockResolvedValue([]);
        getFileStreamMock.mockReset();
        uploadJsonMock.mockReset().mockResolvedValue(undefined);
        getFileJsonMock.mockReset().mockResolvedValue(undefined);
        process.env.S3_REVIEW_BUCKET = 'gsr-review-results-test';
        process.env.S3_BUCKET = 'gsr-eval-results-test';

        const mod = await import('../src/app.js');
        app = mod.app;
    });

    afterEach(() => {
        process.env.S3_REVIEW_BUCKET = originalReviewBucket;
        process.env.S3_BUCKET = originalEvalBucket;
        jest.clearAllMocks();
    });

    it('rejects a missing "from"/"to" with 400', async () => {
        const res = await request(app).get('/api/usage/summary').query({ to: '2026-07-29' });
        expect(res.status).toBe(400);
    });

    it('rejects "to" before "from" with 400', async () => {
        const res = await request(app).get('/api/usage/summary').query({ from: '2026-07-29', to: '2026-07-01' });
        expect(res.status).toBe(400);
    });

    it('rejects a syntactically-valid but nonexistent calendar date (e.g. Feb 30) with 400', async () => {
        // The Date constructor normalizes 2026-02-30 to 2026-03-02 rather
        // than producing NaN, so a naive getTime()-only check would accept
        // it and silently shift the requested range instead of rejecting it.
        const res = await request(app).get('/api/usage/summary').query({ from: '2026-02-30', to: '2026-02-30' });
        expect(res.status).toBe(400);
    });

    it('rejects an invalid granularity with 400', async () => {
        const res = await request(app).get('/api/usage/summary').query({ from: '2026-07-29', to: '2026-07-29', granularity: 'year' });
        expect(res.status).toBe(400);
    });

    it('rejects an invalid source with 400', async () => {
        const res = await request(app).get('/api/usage/summary').query({ from: '2026-07-29', to: '2026-07-29', source: 'bogus' });
        expect(res.status).toBe(400);
    });

    it('rejects a range over the day cap with 400', async () => {
        const res = await request(app).get('/api/usage/summary').query({ from: '2026-01-01', to: '2026-12-31' });
        expect(res.status).toBe(400);
    });

    it('queries both buckets by default (source=all) for a single-day, today-only range', async () => {
        const today = new Date().toISOString().slice(0, 10);
        const res = await request(app).get('/api/usage/summary').query({ from: today, to: today });

        expect(res.status).toBe(200);
        expect(res.body.source).toBe('all');
        expect(res.body.granularity).toBe('day');
        expect(res.body.total.totalCalls).toBe(0);
        // today is never cached: no getFileJson reads, but both buckets are listed.
        expect(getFileJsonMock).not.toHaveBeenCalled();
        const listedBuckets = listFilesMock.mock.calls.map((c: any) => c[0]);
        expect(listedBuckets).toEqual(expect.arrayContaining(['gsr-review-results-test', 'gsr-eval-results-test']));
    });

    it('queries only the review bucket when source=backend', async () => {
        const today = new Date().toISOString().slice(0, 10);
        const res = await request(app).get('/api/usage/summary').query({ from: today, to: today, source: 'backend' });

        expect(res.status).toBe(200);
        const listedBuckets = listFilesMock.mock.calls.map((c: any) => c[0]);
        expect(listedBuckets).toEqual(['gsr-review-results-test']);
    });

    it('queries only the eval bucket when source=eval-harness', async () => {
        const today = new Date().toISOString().slice(0, 10);
        const res = await request(app).get('/api/usage/summary').query({ from: today, to: today, source: 'eval-harness' });

        expect(res.status).toBe(200);
        const listedBuckets = listFilesMock.mock.calls.map((c: any) => c[0]);
        expect(listedBuckets).toEqual(['gsr-eval-results-test']);
    });

    it('reads (not recomputes) a fresh cached rollup for a past day', async () => {
        // aggregate() isn't imported here, so build a minimal fresh-shaped
        // rollup by hand at the current schema version — must be bumped in
        // lockstep with adk/backend/src/usage.ts's CURRENT_SCHEMA_VERSION,
        // or this "reads from cache" test starts exercising the rebuild path
        // instead (schemaVersion mismatch treats the cache as stale).
        const cachedRollup = {
            schemaVersion: 3, date: '2020-01-01',
            totalCalls: 1, successCount: 1, failureCount: 0,
            totalInputTokens: 5, totalOutputTokens: 2, totalThinkingTokens: 0, totalCostUsd: 0.001,
            totalLatencyMs: 10, avgLatencyMs: 10,
            byCallType: {}, byModel: {}, byErrorKind: {},
            byRepository: {}, byWorkload: {}, byModelRepository: {}, byModelWorkload: {}, byRepositoryWorkload: {},
        };
        getFileJsonMock.mockResolvedValue(cachedRollup);

        const res = await request(app).get('/api/usage/summary').query({ from: '2020-01-01', to: '2020-01-01', source: 'backend' });

        expect(res.status).toBe(200);
        expect(res.body.total.totalCalls).toBe(1);
        expect(res.body.total.totalInputTokens).toBe(5);
        expect(listFilesMock).not.toHaveBeenCalled();
        expect(uploadJsonMock).not.toHaveBeenCalled();
    });

    it('groups buckets by month when granularity=month', async () => {
        const res = await request(app)
            .get('/api/usage/summary')
            .query({ from: '2026-01-30', to: '2026-02-02', granularity: 'month', source: 'backend' });

        expect(res.status).toBe(200);
        const labels = res.body.buckets.map((b: any) => b.date).sort();
        expect(labels).toEqual(['2026-01', '2026-02']);
    });

    it('groups buckets by ISO week when granularity=week', async () => {
        // 2026-01-30 through 2026-02-01 fall in ISO week 2026-W05;
        // 2026-02-02 is the first day of 2026-W06.
        const res = await request(app)
            .get('/api/usage/summary')
            .query({ from: '2026-01-30', to: '2026-02-02', granularity: 'week', source: 'backend' });

        expect(res.status).toBe(200);
        const labels = res.body.buckets.map((b: any) => b.date).sort();
        expect(labels).toEqual(['2026-W05', '2026-W06']);
    });
});
