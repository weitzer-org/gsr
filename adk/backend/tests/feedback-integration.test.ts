import { jest, expect, describe, it, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
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
// requireAuth, header/cookie either-or auth, ingestFeedbackBody), the same
// way usage-ingest-integration.test.ts does for /api/usage/ingest.
describe('POST/GET /api/findings/feedback (integration, real app wiring)', () => {
    let app: any;
    const originalKey = process.env.FEEDBACK_SHARED_SECRET;
    const originalPassword = process.env.UI_PASSWORD;

    beforeAll(() => {
        jest.spyOn(console, 'error').mockImplementation(() => {});
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        jest.spyOn(console, 'log').mockImplementation(() => {});
    });

    // Self-review finding: a beforeAll spy with no matching afterAll leaks
    // the mocked console implementation past this suite for the rest of the
    // Jest worker process. jest.clearAllMocks() (below) only clears call
    // history, not the mock implementation itself.
    afterAll(() => {
        jest.restoreAllMocks();
    });

    beforeEach(async () => {
        jest.resetModules();
        listFilesMock.mockReset().mockResolvedValue([]);
        getFileStreamMock.mockReset();
        uploadJsonMock.mockReset().mockResolvedValue(undefined);
        process.env.FEEDBACK_SHARED_SECRET = 'feedback-test-secret';
        delete process.env.UI_PASSWORD;

        const mod = await import('../src/app.js');
        app = mod.app;
    });

    // Self-review finding: `process.env.X = undefined` coerces to the
    // literal string "undefined" rather than deleting the key — restore-or-
    // delete instead, so a test run where these started out unset doesn't
    // leave them permanently (and incorrectly) truthy for later tests.
    afterEach(() => {
        if (originalKey === undefined) delete process.env.FEEDBACK_SHARED_SECRET;
        else process.env.FEEDBACK_SHARED_SECRET = originalKey;
        if (originalPassword === undefined) delete process.env.UI_PASSWORD;
        else process.env.UI_PASSWORD = originalPassword;
        jest.clearAllMocks();
    });

    const oneItem = {
        findingId: 'abc123', file: 'src/x.ts', line: 10, severity: 'HIGH', agent: 'Logic',
        summary: 'a real problem', reviewUrl: 'https://github.com/o/r/pull/1',
        verdict: 'valid', comment: 'confirmed', submittedBy: 'claude-code',
    };

    describe('POST', () => {
        it('rejects a missing key with 401', async () => {
            const res = await request(app).post('/api/findings/feedback').send(oneItem);
            expect(res.status).toBe(401);
        });

        it('rejects a wrong key with 401', async () => {
            const res = await request(app)
                .post('/api/findings/feedback')
                .set('X-Feedback-Key', 'wrong')
                .send(oneItem);
            expect(res.status).toBe(401);
        });

        it('accepts a single item with a valid key', async () => {
            const res = await request(app)
                .post('/api/findings/feedback')
                .set('X-Feedback-Key', 'feedback-test-secret')
                .send(oneItem);

            expect(res.status).toBe(200);
            expect(res.body).toEqual({ status: 'ok', accepted: 1, rejected: 0, errors: [] });
            expect(uploadJsonMock).toHaveBeenCalledTimes(1);
        });

        it('accepts a batch', async () => {
            const res = await request(app)
                .post('/api/findings/feedback')
                .set('X-Feedback-Key', 'feedback-test-secret')
                .send({ reviewUrl: oneItem.reviewUrl, items: [oneItem, oneItem] });

            expect(res.status).toBe(200);
            expect(res.body.accepted).toBe(2);
            expect(uploadJsonMock).toHaveBeenCalledTimes(2);
        });

        it('reports a malformed single-item body as an isolated rejection with 200, not a batch-level 400', async () => {
            const res = await request(app)
                .post('/api/findings/feedback')
                .set('X-Feedback-Key', 'feedback-test-secret')
                .send({ findingId: 'only-this' });

            expect(res.status).toBe(200); // a bare object is treated as a one-item batch, same isolation as a real batch
            expect(res.body.rejected).toBe(1);
            expect(uploadJsonMock).not.toHaveBeenCalled();
        });

        it('stays reachable even when UI_PASSWORD is set (registered before requireAuth)', async () => {
            process.env.UI_PASSWORD = 'unrelated-ui-password';
            const res = await request(app)
                .post('/api/findings/feedback')
                .set('X-Feedback-Key', 'feedback-test-secret')
                .send(oneItem);
            expect(res.status).toBe(200);
        });

        it('accepts a valid session cookie in place of the shared-secret header', async () => {
            process.env.UI_PASSWORD = 'ui-password';
            const authMod = await import('../src/auth.js');
            const cookie = `${authMod.SESSION_COOKIE_NAME}=${authMod.signSession('ui-password')}`;

            const res = await request(app)
                .post('/api/findings/feedback')
                .set('Cookie', cookie)
                .send(oneItem);
            expect(res.status).toBe(200);
        });
    });

    describe('GET (behind the session gate, not the shared-secret one)', () => {
        it('is unauthorized without a session when UI_PASSWORD is set', async () => {
            process.env.UI_PASSWORD = 'ui-password';
            const res = await request(app).get('/api/findings/feedback');
            expect(res.status).toBe(401);
        });

        it('lists feedback files when reachable (no UI_PASSWORD configured)', async () => {
            listFilesMock.mockResolvedValue([{ name: 'feedback_x.json', updated: '2026-01-01T00:00:00.000Z' }]);
            const res = await request(app).get('/api/findings/feedback');
            expect(res.status).toBe(200);
            expect(res.body).toHaveLength(1);
        });

        it('rejects a malformed id on the detail route (path traversal)', async () => {
            const res = await request(app).get('/api/findings/feedback/..%2F..%2F..%2Fetc%2Fpasswd');
            expect(res.status).toBe(400);
            expect(res.body).toEqual({ error: 'Invalid file ID format.' });
        });

        it('rejects an id not prefixed with feedback_', async () => {
            const res = await request(app).get('/api/findings/feedback/review-run_x.json');
            expect(res.status).toBe(400);
        });
    });
});
