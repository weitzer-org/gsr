import { test, expect } from '@playwright/test';

// Use standard local server address for all tests
const URL = 'http://localhost:8080/evals.html';

test.describe('Evals Dashboard UI', () => {
    
    test.beforeEach(async ({ page }) => {
        // Intercept the results list to provide a mock history
        await page.route('**/api/evals/results', async route => {
            const json = [
                { name: 'eval-run_test2.json', updated: '2026-03-22T00:00:00.000Z', size: 2048 },
                { name: 'eval-run_test1.json', updated: '2026-03-21T00:00:00.000Z', size: 1024 }
            ];
            await route.fulfill({ json });
        });

        // Intercept individual result fetching
        await page.route('**/api/evals/results/eval-run_test2.json', async route => {
            const json = {
                run_date: '2026-03-22T00:00:00.000Z',
                environments: {
                    local: { timestamp: '2026-03-22T00:00:00.000Z' },
                    production: { timestamp: '2026-03-22T00:00:00.000Z' }
                },
                results: [
                    {
                        prUrl: 'https://github.com/weitzer-org/test/pull/1',
                        local: { findings: [], metrics: { inputTokens: 50, outputTokens: 10, calls: 1 } },
                        production: { findings: [], metrics: { inputTokens: 100, outputTokens: 20, calls: 2 } },
                        evaluation: 'Local version is an Improvement.'
                    }
                ],
                aggregate_report: 'This is the aggregate executive summary.',
                aggregate_metrics: {
                    local: { inputTokens: 50, outputTokens: 10, calls: 1 },
                    production: { inputTokens: 100, outputTokens: 20, calls: 2 }
                }
            };
            await route.fulfill({ json });
        });
    });

    test('should load history and display run specific details when clicked', async ({ page }) => {
        await page.goto(URL);

        // Sidebar should list the mock files
        const runs = page.locator('.run-list li');
        await expect(runs).toHaveCount(2);

        // Wait for the specific run and click it
        const latestRun = runs.nth(0);
        await expect(latestRun).toContainText('KB');
        await latestRun.click();

        // Wait to make sure click registers and loads data
        await page.waitForTimeout(100);

        // Check if the dashboard populates correctly
        await expect(page.locator('#eval-main')).toBeVisible();

        // Metrics logic
        await expect(page.locator('#metric-local-input')).toHaveText('50');
        await expect(page.locator('#metric-local-output')).toHaveText('10');
        await expect(page.locator('#metric-local-calls')).toHaveText('1');

        await expect(page.locator('#metric-prod-input')).toHaveText('100');
        await expect(page.locator('#metric-prod-output')).toHaveText('20');
        await expect(page.locator('#metric-prod-calls')).toHaveText('2');

        // Check the report markdown body
        const reportText = await page.locator('#aggregate-report').innerText();
        expect(reportText).toContain('This is the aggregate executive summary.');
        
        // Ensure accordion is created for individual PR
        await expect(page.locator('.pr-detail')).toHaveCount(1);
    });

    test('should trigger a new evaluation', async ({ page }) => {
        await page.goto(URL);

        // Intercept start API
        await page.route('**/api/evals/start', async route => {
            const json = { status: 'started' };
            await route.fulfill({ status: 202, json });
        });

        // Click the Run button
        const runBtn = page.locator('#run-eval-btn');
        await runBtn.click();

        // Expect the status notice to indicate starting
        const notice = page.locator('#run-status-notice');
        await expect(notice).toBeVisible();
        await expect(notice).toContainText('Harness running... Check back in');
    });

});
