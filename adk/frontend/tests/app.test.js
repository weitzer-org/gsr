import { jest } from '@jest/globals';

const FIXTURE_HTML = `
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
    <div id="agent-checkbox-list"></div>
    <button type="button" id="agent-select-toggle"></button>
    <small id="agent-selection-error"></small>
`;

describe('App frontend logic (app.js)', () => {
    let initApp;
    let originalConsoleError;

    beforeAll(async () => {
        // Mock the global document and window before loading app.js
        document.body.innerHTML = FIXTURE_HTML;

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

    describe('agent selection', () => {
        // Reset the DOM per test so each initApp() call attaches listeners to fresh
        // elements — reusing the shared fixture across tests would stack duplicate
        // click/change listeners on the same nodes and double-fire toggle logic.
        beforeEach(() => {
            document.body.innerHTML = FIXTURE_HTML;
        });

        function mockFetchWithAgents(agents) {
            global.fetch.mockImplementation((url) => {
                if (url === '/api/agents') {
                    return Promise.resolve({ ok: true, status: 200, json: async () => ({ agents }) });
                }
                return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
            });
        }

        const flush = () => new Promise(process.nextTick).then(() => new Promise(process.nextTick));

        it('renders one checkbox per agent, all checked by default, toggle reads "Select None"', async () => {
            mockFetchWithAgents([{ id: 'logic', displayName: 'Logic' }, { id: 'security', displayName: 'Security' }]);

            initApp();
            await flush();

            const checkboxes = document.querySelectorAll('#agent-checkbox-list input[type="checkbox"]');
            expect(checkboxes.length).toBe(2);
            expect(Array.from(checkboxes).every(cb => cb.checked)).toBe(true);
            expect(document.getElementById('agent-select-toggle').textContent).toBe('Select None');
            expect(document.getElementById('agent-selection-error').classList.contains('hidden')).toBe(true);
        });

        it('unchecking every agent shows the selection error and disables submit', async () => {
            mockFetchWithAgents([{ id: 'logic', displayName: 'Logic' }]);

            initApp();
            await flush();

            const checkbox = document.querySelector('#agent-checkbox-list input[type="checkbox"]');
            checkbox.checked = false;
            checkbox.dispatchEvent(new Event('change'));

            expect(document.getElementById('agent-selection-error').classList.contains('hidden')).toBe(false);
            expect(document.getElementById('submit-btn').disabled).toBe(true);
            expect(document.getElementById('agent-select-toggle').textContent).toBe('Select All');
        });

        it('the select-all/none toggle flips every checkbox', async () => {
            mockFetchWithAgents([{ id: 'logic', displayName: 'Logic' }, { id: 'security', displayName: 'Security' }]);

            initApp();
            await flush();

            const toggle = document.getElementById('agent-select-toggle');
            toggle.click();

            let checkboxes = document.querySelectorAll('#agent-checkbox-list input[type="checkbox"]');
            expect(Array.from(checkboxes).every(cb => !cb.checked)).toBe(true);
            expect(toggle.textContent).toBe('Select All');

            toggle.click();
            checkboxes = document.querySelectorAll('#agent-checkbox-list input[type="checkbox"]');
            expect(Array.from(checkboxes).every(cb => cb.checked)).toBe(true);
            expect(toggle.textContent).toBe('Select None');
        });
    });
});
