import { test, expect } from '@playwright/test';

test.describe('E2E Persistent Review History', () => {
  test('should submit a review, wait for completion, and verify history', async ({ page }) => {
    // 1. Load the page
    await page.goto('/');

    // 2. Ensure connection status is connected
    const statusBadge = page.locator('#connection-status');
    await expect(statusBadge).not.toHaveClass(/checking/, { timeout: 10000 });
    
    // 3. Fill the PR URL input and PAT
    const prInput = page.locator('#pr-url');
    await prInput.fill('https://github.com/benw307/logo-maker-weitzer/pull/69');
    
    const patInput = page.locator('#pat');
    await patInput.fill('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');

    // 4. Submit the review
    const submitBtn = page.locator('#submit-btn');
    await submitBtn.click();

    // Wait for the button to become disabled (review starts)
    await expect(submitBtn).toBeDisabled({ timeout: 5000 });

    // 5. Wait for the review to complete. The submit button is re-enabled once the stream completes and the GCS upload finishes.
    await expect(submitBtn).toBeEnabled({ timeout: 180000 });
    
    // 6. Verify that a new element appeared in the History List Container
    const historyList = page.locator('#history-list');
    const firstHistoryItem = historyList.locator('.history-item').first();
    
    // There should be at least one item and we expect it to become visible
    await expect(firstHistoryItem).toBeVisible({ timeout: 10000 });
    
    // 7. Click the history item to load it
    await firstHistoryItem.click();
    
    // 8. Verify the evaluation text is present (basic check)
    const evalContent = page.locator('#evaluation-text');
    await expect(evalContent).not.toBeEmpty({ timeout: 10000 });
    
    // Explicit 5-second sleep so the Playwright Video captures the loaded Evaluation Content
    // before closing the browser context.
    await page.waitForTimeout(5000);
  });
});
