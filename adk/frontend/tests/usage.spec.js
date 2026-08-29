import { test, expect } from '@playwright/test';

// Use standard local server address for all tests
const URL = 'http://localhost:8080/usage.html';

test.describe('Usage Dashboard UI', () => {

    test.beforeEach(async ({ page }) => {
        await page.route('**/api/usage/summary**', async route => {
            const json = {
                granularity: 'day',
                source: 'all',
                buckets: [
                    {
                        date: '2026-07-29', totalCalls: 3, totalInputTokens: 300, totalOutputTokens: 60, totalThinkingTokens: 10, totalCostUsd: 0.02,
                        byModel: {}, byRepository: {}, byWorkload: {}, byModelRepository: {}, byModelWorkload: {}, byRepositoryWorkload: {},
                    },
                ],
                total: {
                    totalCalls: 3, totalInputTokens: 300, totalOutputTokens: 60, totalThinkingTokens: 10, totalCostUsd: 0.02,
                    byModel: { 'gemini-3.1-pro-preview': { calls: 3, inputTokens: 300, outputTokens: 60, thinkingTokens: 10, costUsd: 0.02 } },
                    byRepository: { 'gsr (hosted)': { calls: 3, inputTokens: 300, outputTokens: 60, thinkingTokens: 10, costUsd: 0.02 } },
                    byWorkload: { review: { calls: 3, inputTokens: 300, outputTokens: 60, thinkingTokens: 10, costUsd: 0.02 } },
                    byModelRepository: {},
                    byModelWorkload: {},
                    byRepositoryWorkload: {},
                },
            };
            await route.fulfill({ json });
        });
    });

    test('should load and display totals from the summary API', async ({ page }) => {
        await page.goto(URL);

        await expect(page.locator('#usage-total-input')).toHaveText('300');
        await expect(page.locator('#usage-total-output')).toHaveText('60');
        await expect(page.locator('#usage-total-thinking')).toHaveText('10');
        await expect(page.locator('#usage-total-cost')).toHaveText('$0.0200');
        await expect(page.locator('#usage-total-calls')).toHaveText('3');

        await expect(page.locator('#usage-breakdown-body')).toContainText('gemini-3.1-pro-preview');
    });

    test('should re-fetch when a quick range button is clicked', async ({ page }) => {
        await page.goto(URL);

        let requestCount = 0;
        page.on('request', req => {
            if (req.url().includes('/api/usage/summary')) requestCount++;
        });

        await page.locator('.quick-range-btn[data-range="week"]').click();
        await page.waitForTimeout(100);

        expect(requestCount).toBeGreaterThan(0);
        await expect(page.locator('.quick-range-btn[data-range="week"]')).toHaveClass(/active/);
    });

});
