import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { compareResultsWithLLM, generateAggregateReport } from '../llm-comparator';
import { GoogleGenAI } from '@google/genai';

// Mock the entire genai module
jest.mock('@google/genai');

describe('LLM Comparator', () => {
  let generateContentMock: any;

  beforeEach(() => {
    process.env.GEMINI_API_KEY = 'test_api_key'; // Set a dummy key

    generateContentMock = jest.fn().mockResolvedValue({
      text: 'Mocked Gemini Response'
    });

    // Mock the constructor behavior of GoogleGenAI
    (GoogleGenAI as jest.Mock).mockImplementation(() => ({
      models: {
        generateContent: generateContentMock
      }
    }));
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('compareResultsWithLLM', () => {
    it('should throw an error if no API key is set', async () => {
      delete process.env.GEMINI_API_KEY;
      await expect(compareResultsWithLLM('pr_url', [], [])).rejects.toThrow('GEMINI_API_KEY must be set');
    });

    it('should successfully ask Gemini to evaluate the comparison and return text', async () => {
      const localFindings = [{ file: 'a.js', message: 'Local finding' }];
      const prodFindings = [{ file: 'b.js', message: 'Prod finding' }];
      
      const responseText = await compareResultsWithLLM('https://github.com/my/pr/1', localFindings as any, prodFindings as any);

      expect(responseText).toBe('Mocked Gemini Response');
      expect(generateContentMock).toHaveBeenCalled();
      
      // Verify prompt construction loosely
      const promptArg = generateContentMock.mock.calls[0][0].contents;
      expect(promptArg).toContain('Context PR: https://github.com/my/pr/1');
      expect(promptArg).toContain('Local finding');
      expect(promptArg).toContain('Prod finding');
    });

    it('should throw if Gemini returns an empty response', async () => {
      generateContentMock.mockResolvedValueOnce({ text: null }); // Mock failure

      await expect(compareResultsWithLLM('pr_url', [], [])).rejects.toThrow('LLM returned empty text');
    });

    it('should throw if Gemini call completely throws an error', async () => {
      generateContentMock.mockRejectedValueOnce(new Error('Network Error'));

      await expect(compareResultsWithLLM('pr_url', [], [])).rejects.toThrow('Network Error');
    });
  });

  describe('generateAggregateReport', () => {
    it('should throw an error if no API key is set', async () => {
      delete process.env.GEMINI_API_KEY;
      await expect(generateAggregateReport(['report1'], {})).rejects.toThrow('GEMINI_API_KEY must be set');
    });

    it('should successfully ask Gemini to generate aggregate report and return text', async () => {
      const metrics = {
        inputTokens: 100,
        outputTokens: 50
      };
      
      const reports = ['Report 1 details', 'Report 2 details'];
      
      const responseText = await generateAggregateReport(reports, metrics);

      expect(responseText).toBe('Mocked Gemini Response');
      expect(generateContentMock).toHaveBeenCalled();
      
      // Verify prompt construction loosely
      const promptArg = generateContentMock.mock.calls[0][0].contents;
      expect(promptArg).toContain('Report 1 details');
      expect(promptArg).toContain('Report 2 details');
      expect(promptArg).toContain('"inputTokens": 100');
    });

    it('should throw if Gemini returns an empty response', async () => {
      generateContentMock.mockResolvedValueOnce({ text: null }); // Mock failure

      await expect(generateAggregateReport(['r1'], {})).rejects.toThrow('LLM returned empty text for aggregate report');
    });

    it('should throw if Gemini call completely throws an error', async () => {
      generateContentMock.mockRejectedValueOnce(new Error('Network Error'));

      await expect(generateAggregateReport(['r1'], {})).rejects.toThrow('Network Error');
    });
  });
});
