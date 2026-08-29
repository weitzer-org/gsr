import { jest } from '@jest/globals';

const DOM = `
    <input type="date" id="usage-from">
    <input type="date" id="usage-to">
    <select id="usage-granularity">
        <option value="day" selected>Day</option>
        <option value="week">Week</option>
        <option value="month">Month</option>
    </select>
    <select id="usage-source">
        <option value="all" selected>All</option>
        <option value="backend">GSR backend</option>
        <option value="eval-harness">Eval harness</option>
    </select>
    <div id="usage-status-notice" class="hidden"></div>
    <span id="usage-range-badge"></span>
    <span id="usage-total-input"></span>
    <span id="usage-total-output"></span>
    <span id="usage-total-thinking"></span>
    <span id="usage-total-cost"></span>
    <span id="usage-total-calls"></span>
    <select id="usage-timeseries-metric">
        <option value="totalCostUsd" selected>Cost</option>
        <option value="totalInputTokens">Input tokens</option>
    </select>
    <div id="usage-timeseries"></div>
    <select id="usage-breakdown-by">
        <option value="byModel" selected>Model</option>
        <option value="byRepository">Consuming project</option>
        <option value="byWorkload">Workload</option>
    </select>
    <select id="usage-breakdown-intersect">
        <option value="" selected>None</option>
        <option value="byModelRepository">Model x project</option>
        <option value="byModelWorkload">Model x workload</option>
        <option value="byRepositoryWorkload">Project x workload</option>
    </select>
    <table>
        <thead><tr><th id="usage-breakdown-col-1"></th><th id="usage-breakdown-col-2"></th></tr></thead>
        <tbody id="usage-breakdown-body"></tbody>
    </table>
    <button class="quick-range-btn active" data-range="today">Today</button>
    <button class="quick-range-btn" data-range="week">This week</button>
    <button class="quick-range-btn" data-range="month">This month</button>
    <button class="quick-range-btn" data-range="90d">Last 90 days</button>
`;

describe('Usage dashboard frontend logic (usage.js)', () => {
    let initUsage;
    let originalConsoleError;

    beforeAll(async () => {
        document.body.innerHTML = DOM;

        originalConsoleError = console.error;
        console.error = jest.fn();

        global.fetch = jest.fn();

        const mod = await import('../usage.js');
        initUsage = mod.initUsage;
    });

    afterAll(() => {
        console.error = originalConsoleError;
        jest.restoreAllMocks();
    });

    beforeEach(() => {
        jest.clearAllMocks();
        // Reset the DOM before each test — initUsage() attaches event
        // listeners on every call, and reusing the same nodes across tests
        // without resetting would accumulate listeners (a later click
        // firing every previous test's handler too).
        document.body.innerHTML = DOM;
    });

    const summaryResponse = {
        granularity: 'day',
        source: 'all',
        buckets: [
            {
                date: '2026-07-28', totalCalls: 2, totalInputTokens: 100, totalOutputTokens: 20, totalThinkingTokens: 5, totalCostUsd: 0.01,
                byModel: {}, byRepository: {}, byWorkload: {}, byModelRepository: {}, byModelWorkload: {}, byRepositoryWorkload: {},
            },
            {
                date: '2026-07-29', totalCalls: 3, totalInputTokens: 200, totalOutputTokens: 40, totalThinkingTokens: 10, totalCostUsd: 0.02,
                byModel: {}, byRepository: {}, byWorkload: {}, byModelRepository: {}, byModelWorkload: {}, byRepositoryWorkload: {},
            },
        ],
        total: {
            totalCalls: 5, totalInputTokens: 300, totalOutputTokens: 60, totalThinkingTokens: 15, totalCostUsd: 0.03,
            byModel: { 'gemini-3.1-pro-preview': { calls: 5, inputTokens: 300, outputTokens: 60, thinkingTokens: 15, costUsd: 0.03 } },
            byRepository: { 'gsr (hosted)': { calls: 5, inputTokens: 300, outputTokens: 60, thinkingTokens: 15, costUsd: 0.03 } },
            byWorkload: { review: { calls: 5, inputTokens: 300, outputTokens: 60, thinkingTokens: 15, costUsd: 0.03 } },
            byModelRepository: { 'gemini-3.1-pro-preview|gsr (hosted)': { calls: 5, inputTokens: 300, outputTokens: 60, thinkingTokens: 15, costUsd: 0.03 } },
            byModelWorkload: {},
            byRepositoryWorkload: {},
        },
    };

    it('initializes without throwing and fetches a summary on load', () => {
        global.fetch.mockResolvedValueOnce({ ok: true, json: async () => summaryResponse });
        expect(() => initUsage()).not.toThrow();
        expect(global.fetch).toHaveBeenCalledTimes(1);
        expect(global.fetch.mock.calls[0][0]).toContain('/api/usage/summary?');
    });

    it('renders totals from the fetched summary', async () => {
        global.fetch.mockResolvedValueOnce({ ok: true, json: async () => summaryResponse });
        initUsage();
        await new Promise(process.nextTick);

        expect(document.getElementById('usage-total-input').textContent).toBe('300');
        expect(document.getElementById('usage-total-output').textContent).toBe('60');
        expect(document.getElementById('usage-total-thinking').textContent).toBe('15');
        expect(document.getElementById('usage-total-cost').textContent).toBe('$0.0300');
        expect(document.getElementById('usage-total-calls').textContent).toBe('5');
    });

    it('renders one time series row per bucket', async () => {
        global.fetch.mockResolvedValueOnce({ ok: true, json: async () => summaryResponse });
        initUsage();
        await new Promise(process.nextTick);

        const rows = document.querySelectorAll('#usage-timeseries .usage-bar-row');
        expect(rows.length).toBe(2);
    });

    it('renders the byModel breakdown by default', async () => {
        global.fetch.mockResolvedValueOnce({ ok: true, json: async () => summaryResponse });
        initUsage();
        await new Promise(process.nextTick);

        const body = document.getElementById('usage-breakdown-body');
        expect(body.textContent).toContain('gemini-3.1-pro-preview');
    });

    it('switches to an intersection breakdown when selected', async () => {
        global.fetch.mockResolvedValueOnce({ ok: true, json: async () => summaryResponse });
        initUsage();
        await new Promise(process.nextTick);

        document.getElementById('usage-breakdown-intersect').value = 'byModelRepository';
        document.getElementById('usage-breakdown-intersect').dispatchEvent(new Event('change'));

        const body = document.getElementById('usage-breakdown-body');
        expect(body.textContent).toContain('gemini-3.1-pro-preview');
        expect(body.textContent).toContain('gsr (hosted)');
    });

    it('keeps column headers matching the row data even when "By" is not the intersection\'s first dimension', async () => {
        global.fetch.mockResolvedValueOnce({ ok: true, json: async () => summaryResponse });
        initUsage();
        await new Promise(process.nextTick);

        // Select "Consuming project" as the primary dimension, THEN
        // intersect with model x repository — the composite key is always
        // "model|repository" regardless of this "by" choice, so headers
        // must reflect that fixed order, not "by".
        const bySelect = document.getElementById('usage-breakdown-by');
        bySelect.value = 'byRepository';
        bySelect.dispatchEvent(new Event('change'));
        const intersectSelect = document.getElementById('usage-breakdown-intersect');
        intersectSelect.value = 'byModelRepository';
        intersectSelect.dispatchEvent(new Event('change'));

        expect(document.getElementById('usage-breakdown-col-1').textContent).toBe('Model');
        expect(document.getElementById('usage-breakdown-col-2').textContent).toBe('Consuming project');

        const firstRow = document.querySelector('#usage-breakdown-body tr');
        const cells = firstRow.querySelectorAll('td');
        expect(cells[0].textContent).toBe('gemini-3.1-pro-preview');
        expect(cells[1].textContent).toBe('gsr (hosted)');
    });

    it('shows an error notice when the fetch fails', async () => {
        global.fetch.mockRejectedValueOnce(new Error('Network offline'));
        initUsage();
        await new Promise(process.nextTick);

        const notice = document.getElementById('usage-status-notice');
        expect(notice.textContent).toContain('Network offline');
        expect(notice.classList.contains('hidden')).toBe(false);
    });

    it('hides the status notice again once a successful fetch completes', async () => {
        global.fetch.mockResolvedValueOnce({ ok: true, json: async () => summaryResponse });
        initUsage();
        await new Promise(process.nextTick);

        const notice = document.getElementById('usage-status-notice');
        expect(notice.classList.contains('hidden')).toBe(true);
    });

    it('ignores a slower, superseded response instead of overwriting newer data', async () => {
        let resolveFirst;
        const firstResponse = new Promise(resolve => { resolveFirst = resolve; });
        global.fetch.mockReturnValueOnce(firstResponse);
        initUsage(); // kicks off the "first" (slow) request
        await Promise.resolve();

        const secondSummary = { ...summaryResponse, total: { ...summaryResponse.total, totalCalls: 999 } };
        global.fetch.mockResolvedValueOnce({ ok: true, json: async () => secondSummary });
        document.querySelector('[data-range="week"]').click(); // fires the "second" (fast) request
        await new Promise(process.nextTick);

        // The slow first request now resolves late, after the second already rendered.
        resolveFirst({ ok: true, json: async () => summaryResponse });
        await new Promise(process.nextTick);

        expect(document.getElementById('usage-total-calls').textContent).toBe('999');
    });

    it('ignores a superseded response even when only its .json() decode (not the fetch itself) resolves late', async () => {
        let resolveFirstJson;
        const firstJson = new Promise(resolve => { resolveFirstJson = resolve; });
        global.fetch.mockResolvedValueOnce({ ok: true, json: () => firstJson });
        initUsage(); // fetch() resolves immediately; decoding its body is what's slow
        await Promise.resolve();

        const secondSummary = { ...summaryResponse, total: { ...summaryResponse.total, totalCalls: 999 } };
        global.fetch.mockResolvedValueOnce({ ok: true, json: async () => secondSummary });
        document.querySelector('[data-range="week"]').click();
        await new Promise(process.nextTick);

        // The first request's body decode now finishes late, after the second already rendered.
        resolveFirstJson(summaryResponse);
        await new Promise(process.nextTick);

        expect(document.getElementById('usage-total-calls').textContent).toBe('999');
    });

    it('re-fetches with an updated range when a quick-range button is clicked', async () => {
        global.fetch.mockResolvedValue({ ok: true, json: async () => summaryResponse });
        initUsage();
        await new Promise(process.nextTick);
        jest.clearAllMocks();
        global.fetch.mockResolvedValueOnce({ ok: true, json: async () => summaryResponse });

        document.querySelector('[data-range="week"]').click();
        await new Promise(process.nextTick);

        expect(global.fetch).toHaveBeenCalledTimes(1);
    });
});
