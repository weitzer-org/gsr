import { jest } from '@jest/globals';

describe('App frontend logic (app.js)', () => {
    let initApp;
    let originalConsoleError;

    beforeAll(async () => {
        // Mock the global document and window before loading app.js
        document.body.innerHTML = `
            <form id="review-form"></form>
            <button id="submit-btn"></button>
            <span class="btn-text"></span>
            <div class="spinner"></div>
            <div id="results-container"></div>
            <button class="tab-btn" data-tab="tab1"></button>
            <div class="tab-content" id="tab1"></div>
            <ul id="subagent-findings-list"></ul>
            <ul id="basic-findings-list"></ul>
            <tbody id="comparison-table-body"></tbody>
            <table id="comparison-table"></table>
            <div id="comparison-evaluation"></div>
            <div id="evaluation-text"></div>
            <div id="connection-status"><span class="status-text"></span></div>
        `;

        originalConsoleError = console.error;
        console.error = jest.fn(); // Suppress errors intentionally thrown by fetch during tests

        // Setup global fetch mock
        global.fetch = jest.fn();

        const mod = await import('../app.js');
        initApp = mod.initApp;
    });

    afterAll(() => {
        console.error = originalConsoleError;
        jest.restoreAllMocks();
    });

    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('should initialize app properly when initApp is called', () => {
        expect(() => initApp()).not.toThrow();
    });
    
    it('should check API status and update DOM when disconnected', async () => {
        global.fetch.mockRejectedValueOnce(new Error('Network offline'));
        
        initApp(); // triggers checkApiStatus
        
        // Wait for microtasks
        await new Promise(process.nextTick);
        
        const statusBadge = document.getElementById('connection-status');
        const statusText = statusBadge?.querySelector('.status-text');
        
        expect(statusBadge?.classList.contains('disconnected')).toBe(true);
        expect(statusText?.textContent).toBe('Backend API: Offline');
    });

    it('should handle successful API status check', async () => {
        global.fetch.mockResolvedValueOnce({
            json: async () => ({ geminiConnected: true, model: 'gemini-test' })
        });
        
        initApp(); // triggers checkApiStatus
        await new Promise(process.nextTick);
        
        const statusBadge = document.getElementById('connection-status');
        const statusText = statusBadge?.querySelector('.status-text');
        
        expect(statusBadge?.classList.contains('connected')).toBe(true);
        expect(statusText?.textContent).toMatch(/gemini-test/);
    });
});
