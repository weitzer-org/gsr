import { jest } from '@jest/globals';
import { TextDecoder, TextEncoder } from 'util';

// jsdom's test environment doesn't expose TextDecoder globally; app.js needs it
// to read the review-stream response body.
if (typeof global.TextDecoder === 'undefined') {
    global.TextDecoder = TextDecoder;
}
if (typeof global.TextEncoder === 'undefined') {
    global.TextEncoder = TextEncoder;
}

const FIXTURE_HTML = `
    <form id="review-form">
        <input id="pr-url" value="https://github.com/owner/repo/pull/1">
        <input id="pat" value="mock-pat">
    </form>
    <button id="submit-btn"></button>
    <span class="btn-text"></span>
    <div class="spinner"></div>
    <div id="results-container"></div>
    <button class="tab-btn" data-tab="tab1"></button>
    <div class="tab-content" id="tab1"></div>
    <ul id="subagent-findings-list"></ul>
    <ul id="basic-findings-list"></ul>
    <div id="progress-container" class="hidden"><div id="progress-grid"></div></div>
    <div id="warning-container" class="hidden"></div>
    <table id="comparison-table">
        <tbody id="comparison-table-body"></tbody>
    </table>
    <div id="comparison-evaluation"></div>
    <div id="evaluation-text"></div>
    <div id="connection-status"><span class="status-text"></span></div>
    <div id="agent-checkbox-list"></div>
    <button type="button" id="agent-select-toggle"></button>
    <small id="agent-selection-error" class="hidden"></small>
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

        it('renders display names as plain text without double-escaping HTML entities', async () => {
            mockFetchWithAgents([{ id: 'r-and-d', displayName: 'R&D' }]);

            initApp();
            await flush();

            const label = document.querySelector('#agent-checkbox-list .agent-checkbox-item');
            // textContent reflects the actual text data (un-serialized); double-escaping
            // via escapeHTML() inside createTextNode would make this literally "R&amp;D".
            expect(label.textContent).toBe('R&D');
        });

        it('does not block submission when the /api/agents fetch fails (falls back to the full swarm)', async () => {
            global.fetch.mockImplementation((url) => {
                if (url === '/api/agents') return Promise.reject(new Error('network down'));
                return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
            });

            initApp();
            await flush();

            expect(document.querySelectorAll('#agent-checkbox-list input[type="checkbox"]').length).toBe(0);
            expect(document.getElementById('submit-btn').disabled).toBe(false);
            expect(document.getElementById('agent-selection-error').classList.contains('hidden')).toBe(true);
        });

        it('does not re-enable submit when a checkbox changes while a review is in flight', async () => {
            global.fetch.mockImplementation((url) => {
                if (url === '/api/agents') {
                    return Promise.resolve({ ok: true, status: 200, json: async () => ({ agents: [{ id: 'logic', displayName: 'Logic' }, { id: 'security', displayName: 'Security' }] }) });
                }
                if (url === '/api/review') {
                    // Never-resolving reader simulates a request that's still streaming.
                    return Promise.resolve({ ok: true, status: 200, body: { getReader: () => ({ read: () => new Promise(() => {}) }) } });
                }
                return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
            });

            initApp();
            await flush();

            document.getElementById('review-form').dispatchEvent(new Event('submit', { cancelable: true }));
            await new Promise(resolve => setTimeout(resolve, 0));
            expect(document.getElementById('submit-btn').disabled).toBe(true);

            const checkbox = document.querySelector('#agent-checkbox-list input[type="checkbox"]');
            checkbox.checked = false;
            checkbox.dispatchEvent(new Event('change'));

            expect(document.getElementById('submit-btn').disabled).toBe(true);
        });

        it('sends agents in the request body for a partial selection, and omits it for the full selection', async () => {
            // Each /api/review call gets a reader that reports "done" on the first read,
            // so the submission completes (and isSubmitting resets) instead of hanging —
            // this test does two submissions in sequence, unlike the in-flight test above.
            const immediatelyDoneBody = { ok: true, status: 200, body: { getReader: () => ({ read: () => Promise.resolve({ done: true, value: undefined }) }) } };
            global.fetch.mockImplementation((url) => {
                if (url === '/api/agents') {
                    return Promise.resolve({ ok: true, status: 200, json: async () => ({ agents: [{ id: 'logic', displayName: 'Logic' }, { id: 'security', displayName: 'Security' }] }) });
                }
                if (url === '/api/review') return Promise.resolve(immediatelyDoneBody);
                return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
            });

            initApp();
            await flush();

            // Full selection (default): agents omitted from the payload.
            document.getElementById('review-form').dispatchEvent(new Event('submit', { cancelable: true }));
            await new Promise(resolve => setTimeout(resolve, 0));

            let reviewCall = global.fetch.mock.calls.find(c => c[0] === '/api/review');
            expect(JSON.parse(reviewCall[1].body)).not.toHaveProperty('agents');
            expect(document.getElementById('submit-btn').disabled).toBe(false); // submission completed, isSubmitting reset

            // Partial selection: agents included, matching only the checked ids.
            document.querySelectorAll('#agent-checkbox-list input[type="checkbox"]')[0].click();
            global.fetch.mockClear();
            document.getElementById('review-form').dispatchEvent(new Event('submit', { cancelable: true }));
            await new Promise(resolve => setTimeout(resolve, 0));

            reviewCall = global.fetch.mock.calls.find(c => c[0] === '/api/review');
            expect(JSON.parse(reviewCall[1].body).agents).toEqual(['security']);
        });

        it('ignores a second submit while one is already in flight (no duplicate request)', async () => {
            global.fetch.mockImplementation((url) => {
                if (url === '/api/agents') {
                    return Promise.resolve({ ok: true, status: 200, json: async () => ({ agents: [{ id: 'logic', displayName: 'Logic' }] }) });
                }
                if (url === '/api/review') {
                    return Promise.resolve({ ok: true, status: 200, body: { getReader: () => ({ read: () => new Promise(() => {}) }) } });
                }
                return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
            });

            initApp();
            await flush();

            const form = document.getElementById('review-form');
            form.dispatchEvent(new Event('submit', { cancelable: true }));
            await new Promise(resolve => setTimeout(resolve, 0));

            global.fetch.mockClear();
            form.dispatchEvent(new Event('submit', { cancelable: true }));
            await new Promise(resolve => setTimeout(resolve, 0));

            expect(global.fetch.mock.calls.find(c => c[0] === '/api/review')).toBeUndefined();
        });
    });

    // PR diff filenames and LLM-derived fields reach the page through the
    // progress stream and the findings list; they are attacker-controlled.
    describe('rendering untrusted review fields', () => {
        const flush = () => new Promise(process.nextTick).then(() => new Promise(process.nextTick));
        const evilFile = '"><img src=x onerror="alert(1)">.ts';
        const evilAgent = '<img src=x onerror="alert(1)">';

        const streamOf = (events) => {
            const chunks = [new TextEncoder().encode(events.map(e => JSON.stringify(e)).join('\n') + '\n')];
            return { getReader: () => ({ read: () => Promise.resolve(chunks.length ? { done: false, value: chunks.shift() } : { done: true, value: undefined }) }) };
        };

        const submitWith = async (events) => {
            global.fetch.mockImplementation((url) => {
                if (url === '/api/review') return Promise.resolve({ ok: true, status: 200, body: streamOf(events) });
                if (url === '/api/agents') return Promise.resolve({ ok: true, status: 200, json: async () => ({ agents: [] }) });
                return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
            });
            initApp();
            await flush();
            document.getElementById('review-form').dispatchEvent(new Event('submit', { cancelable: true }));
            await new Promise(resolve => setTimeout(resolve, 0));
            await flush();
        };

        beforeEach(() => {
            document.getElementById('progress-grid').innerHTML = '';
            document.getElementById('subagent-findings-list').innerHTML = '';
            document.getElementById('basic-findings-list').innerHTML = '';
        });

        it('shows agent and file names in progress cards as text, not markup', async () => {
            await submitWith([
                { type: 'progress', agent: evilAgent, file: evilFile, status: 'start' },
                { type: 'progress', agent: evilAgent, file: evilFile, status: 'skipped' },
            ]);

            const grid = document.getElementById('progress-grid');
            expect(grid.querySelectorAll('.progress-card').length).toBeGreaterThan(0);
            expect(grid.querySelector('img')).toBeNull();
            grid.querySelectorAll('.file-name').forEach(el => {
                expect(el.textContent).toBe(evilFile);
                expect(el.getAttribute('title')).toBe(evilFile);
                expect(el.hasAttribute('onerror')).toBe(false);
            });
            grid.querySelectorAll('.agent-name').forEach(el => {
                expect(el.textContent).toBe(`🤖 ${evilAgent} Agent`);
            });
        });

        it('shows finding file, agent and line as text, not markup', async () => {
            await submitWith([
                { type: 'done', findings: [
                    { source: 'subagent', agent: evilAgent, file: evilFile, line: '1<img src=x onerror="alert(1)">', severity: 'HIGH', description: '<b>desc</b>' },
                    { source: 'basic', agent: 'Basic', file: evilFile, line: 3, severity: 'LOW', description: 'ok' },
                ] },
            ]);

            for (const id of ['subagent-findings-list', 'basic-findings-list']) {
                const list = document.getElementById(id);
                expect(list.querySelector('.finding')).not.toBeNull();
                expect(list.querySelector('img')).toBeNull();
                expect(list.querySelector('b')).toBeNull();
                expect(list.querySelector('.location').textContent).toContain(evilFile);
            }
        });
    });
});
