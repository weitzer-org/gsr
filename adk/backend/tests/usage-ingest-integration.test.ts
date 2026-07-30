import { jest, expect, describe, it, beforeAll, beforeEach, afterEach } from '@jest/globals';
import request from 'supertest';

const listFilesMock = jest.fn<any>();
const getFileStreamMock = jest.fn<any>();
const uploadJsonMock = jest.fn<any>();

jest.unstable_mockModule('../src/storage.js', () => ({
    uploadJson: uploadJsonMock,
    listFiles: listFilesMock,
    getFileStream: getFileStreamMock
}));

// Exercises the real app.ts wiring end-to-end (route placement relative to
// requireAuth, header parsing, ingestUsageRecords), the same way
// auth-integration.test.ts does for the login/session routes.
describe('POST /api/usage/ingest (integration, real app wiring)', () => {
    let app: any;
    const originalKey = process.env.USAGE_INGEST_SHARED_SECRET;
    const originalPassword = process.env.UI_PASSWORD;

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
        process.env.USAGE_INGEST_SHARED_SECRET = 'ingest-test-secret';

        const mod = await import('../src/app.js');
        app = mod.app;
    });

    afterEach(() => {
        process.env.USAGE_INGEST_SHARED_SECRET = originalKey;
        process.env.UI_PASSWORD = originalPassword;
        jest.clearAllMocks();
    });

    const oneRecord = {
        timestamp: '2026-07-30T00:00:00.000Z', provider: 'gemini', callType: 'discovery',
        model: 'x', inputTokens: 1, outputTokens: 1, latencyMs: 1, costUsd: 0, success: true,
    };

    it('rejects a missing key with 401', async () => {
        const res = await request(app).post('/api/usage/ingest').send({ records: [oneRecord] });
        expect(res.status).toBe(401);
    });

    it('rejects a wrong key with 401', async () => {
        const res = await request(app)
            .post('/api/usage/ingest')
            .set('X-Usage-Ingest-Key', 'wrong')
            .send({ records: [oneRecord] });
        expect(res.status).toBe(401);
    });

    it('accepts a valid batch and writes one object per record', async () => {
        const res = await request(app)
            .post('/api/usage/ingest')
            .set('X-Usage-Ingest-Key', 'ingest-test-secret')
            .send({ repository: 'weitzer-org/logo-maker', records: [oneRecord, oneRecord] });

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ status: 'ok', accepted: 2, failed: 0 });
        expect(uploadJsonMock).toHaveBeenCalledTimes(2);
    });

    it('rejects an empty records array with 400', async () => {
        const res = await request(app)
            .post('/api/usage/ingest')
            .set('X-Usage-Ingest-Key', 'ingest-test-secret')
            .send({ records: [] });
        expect(res.status).toBe(400);
    });

    it('rejects a batch over the record cap with 400', async () => {
        const tooMany = Array.from({ length: 501 }, () => oneRecord);
        const res = await request(app)
            .post('/api/usage/ingest')
            .set('X-Usage-Ingest-Key', 'ingest-test-secret')
            .send({ records: tooMany });
        expect(res.status).toBe(400);
        expect(uploadJsonMock).not.toHaveBeenCalled();
    });

    it('stays reachable even when UI_PASSWORD is set (registered before requireAuth)', async () => {
        process.env.UI_PASSWORD = 'unrelated-ui-password';
        const res = await request(app)
            .post('/api/usage/ingest')
            .set('X-Usage-Ingest-Key', 'ingest-test-secret')
            .send({ records: [oneRecord] });
        expect(res.status).toBe(200);
    });
});
