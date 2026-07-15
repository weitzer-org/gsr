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

// Route-gating behavior lives partly in auth.ts and partly in how app.ts
// mounts requireAuth relative to each route — this exercises the real
// wiring end-to-end rather than auth.ts's exported functions in isolation.
describe('route gating (integration, real app wiring)', () => {
    let app: any;
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
        uploadJsonMock.mockReset();

        const mod = await import('../src/app.js');
        app = mod.app;
    });

    afterEach(() => {
        process.env.UI_PASSWORD = originalPassword;
        jest.clearAllMocks();
    });

    it('does not gate anything when UI_PASSWORD is unset', async () => {
        delete process.env.UI_PASSWORD;

        const res = await request(app).get('/api/review/history');

        expect(res.status).not.toBe(401);
    });

    describe('with UI_PASSWORD set', () => {
        beforeEach(() => {
            process.env.UI_PASSWORD = 'integration-test-secret';
        });

        it('/api/status stays public', async () => {
            const res = await request(app).get('/api/status');
            expect(res.status).toBe(200);
        });

        it('GET /login is reachable without a session', async () => {
            const res = await request(app).get('/login');
            expect(res.status).toBe(200);
        });

        it('rejects an unauthenticated /api/* request with 401 JSON', async () => {
            const res = await request(app).get('/api/review/history');
            expect(res.status).toBe(401);
            expect(res.body).toEqual({ error: 'Unauthorized' });
        });

        it('POST /login with the wrong password does not grant a session', async () => {
            const loginRes = await request(app).post('/login').send({ password: 'wrong' });
            expect(loginRes.status).toBe(401);
            expect(loginRes.headers['set-cookie']).toBeUndefined();
        });

        it('POST /login with the correct password grants access to gated routes', async () => {
            const loginRes = await request(app).post('/login').send({ password: 'integration-test-secret' });
            expect(loginRes.status).toBe(200);
            const cookie = loginRes.headers['set-cookie'];
            expect(cookie).toBeDefined();

            const res = await request(app).get('/api/review/history').set('Cookie', cookie);

            expect(res.status).not.toBe(401);
        });

        it('POST /logout revokes a previously valid session', async () => {
            const loginRes = await request(app).post('/login').send({ password: 'integration-test-secret' });
            const cookie = loginRes.headers['set-cookie'];

            const logoutRes = await request(app).post('/logout').set('Cookie', cookie);
            expect(logoutRes.status).toBe(200);
            const clearedCookie = logoutRes.headers['set-cookie'];

            const res = await request(app).get('/api/review/history').set('Cookie', clearedCookie);

            expect(res.status).toBe(401);
        });
    });
});
