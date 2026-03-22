import { jest } from '@jest/globals';

describe('Evals frontend logic (evals.js)', () => {
    let initEvals;
    let originalConsoleError;

    beforeAll(async () => {
        // Mock the global document and window before loading evals.js
        document.body.innerHTML = `
            <button id="run-eval-btn"></button>
            <div id="run-status-notice"></div>
            <ul id="run-list"></ul>
            <div id="eval-main"></div>
            <div id="aggregate-report"></div>
            <span id="metric-a-input"></span>
            <span id="metric-a-output"></span>
            <span id="metric-a-calls"></span>
            <span id="metric-b-input"></span>
            <span id="metric-b-output"></span>
            <span id="metric-b-calls"></span>
            <span id="label-metric-a-tokens"></span>
            <span id="label-metric-a-calls"></span>
            <span id="label-metric-b-tokens"></span>
            <span id="label-metric-b-calls"></span>
            <span id="run-date-badge"></span>
            <div id="pr-accordion"></div>
            <select id="comparison-group">
                <option value="local-v-branch">local-v-branch</option>
                <option value="branch-v-prod">branch-v-prod</option>
            </select>
            <input type="text" id="branch-name" />
        `;

        originalConsoleError = console.error;
        console.error = jest.fn(); // Suppress errors intentionally thrown by fetch during tests

        // Setup global fetch mock
        global.fetch = jest.fn();

        const mod = await import('../evals.js');
        initEvals = mod.initEvals;
    });

    afterAll(() => {
        console.error = originalConsoleError;
        jest.restoreAllMocks();
    });

    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('should initialize app properly when initEvals is called', () => {
        global.fetch.mockResolvedValueOnce({
            ok: true,
            json: async () => []
        });
        
        expect(() => initEvals()).not.toThrow();
    });

    it('should show error when fetching runs fails', async () => {
        global.fetch.mockRejectedValueOnce(new Error('Network offline'));
        
        initEvals(); 
        
        // Wait for microtasks
        await new Promise(process.nextTick);
        
        const runList = document.getElementById('run-list');
        expect(runList?.innerHTML).toContain('Error loading history: Network offline');
    });
});
