import { describe, it } from 'node:test';
import * as assert from 'node:assert';

describe('LLM Comparator Test', () => {
    it('Should be importable without crashing', async () => {
        // We import the comparator dynamically to ensure it parses successfully
        const { compareResultsWithLLM } = await import('./llm-comparator');
        assert.ok(compareResultsWithLLM, 'compareResultsWithLLM should be exported');
    });
});
