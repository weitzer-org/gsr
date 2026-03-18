import { test, expect } from '@playwright/test';

test.describe('Frontend Integration', () => {
  
  test('should load the page and show connection status', async ({ page }) => {
    await page.goto('/');

    // Verify Title
    await expect(page).toHaveTitle('GSR - Code Review ADK');

    // Verify Header
    const header = page.locator('h1');
    await expect(header).toHaveText('Gemini Subagent Reviewer');

    // Wait for connection status to become connected
    const statusBadge = page.locator('#connection-status');
    // The badge starts with 'checking', turns 'connected' or 'disconnected'
    await expect(statusBadge).not.toHaveClass(/checking/); 

    const statusText = statusBadge.locator('.status-text');
    // It could be connected or offline depending on backend, 
    // but it shouldn't be 'Checking' after a moment.
    await expect(statusText).not.toContainText('Checking');
  });

  test('should have form inputs ready', async ({ page }) => {
    await page.goto('/');
    
    const prInput = page.locator('#pr-url');
    const patInput = page.locator('#pat');
    const submitBtn = page.locator('#submit-btn');

    await expect(prInput).toBeVisible();
    await expect(patInput).toBeVisible();
    await expect(submitBtn).toBeVisible();
  });
});
