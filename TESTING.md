# Testing Guide

This document outlines the testing strategies and tools used in the GSR (Gemini Subagent Reviewer) project.

## 🧪 Test Types

### 1. Unit & Integration Tests (Jest)
We use `jest` and `ts-jest` for unit and integration testing of business logic, utilities, and subagents.

*   **Locations**: 
    *   `adk/backend/tests/`
    *   `adk/frontend/tests/`
*   **Commands**:
    *   In `adk/backend`: `npm test`
    *   In `adk/frontend`: `npm test`

### 2. E2E Testing (Playwright)
We use Playwright for end-to-end testing of the web application interface.

*   **Location**: Controlled by `adk/frontend/playwright.config.js`.
*   **Commands**: Run Playwright tests from the `adk/frontend` directory (e.g., `npx playwright test`).

### 3. Evaluation Harness & Ablation Testing
For testing the effectiveness of the AI models and subagents themselves on real Pull Requests, we use a custom evaluation harness.

*   **Location**: `tools/eval/`
*   **Document**: See [ABLATION.md](tools/eval/ABLATION.md) for details on how to run ablation tests to measure agent impact by selectively disabling them.

## 📝 Best Practices

1.  **Coverage**: Aim for high coverage on business logic and critical paths.
2.  **Mocks**: Use mocks for external services like GitHub API and Gemini API where appropriate in unit tests to ensure speed and determinism.
3.  **E2E**: Ensure critical user flows are covered by Playwright tests before deploying changes.
