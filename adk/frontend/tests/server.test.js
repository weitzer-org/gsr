/** @jest-environment node */
import { jest } from '@jest/globals';
import { app } from '../server.js';

describe('Frontend Server (server.js)', () => {
    let server;
    const PORT = 3001;

    let originalLog;
    beforeAll((done) => {
        originalLog = console.log;
        console.log = jest.fn();
        server = app.listen(PORT, done);
    });
    
    afterAll((done) => {
        console.log = originalLog;
        if (server) server.close(done);
        else done();
    });

    it('should serve index.html on root request', async () => {
        const res = await fetch(`http://localhost:${PORT}/`);
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toMatch(/html/);
    });

    it('should act as SPA and fallback to index.html for unknown routes', async () => {
        const res = await fetch(`http://localhost:${PORT}/unknown-route`);
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toMatch(/html/);
    });

    it('should serve static files properly', async () => {
        const res = await fetch(`http://localhost:${PORT}/app.js`);
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toMatch(/javascript/);
    });
});
