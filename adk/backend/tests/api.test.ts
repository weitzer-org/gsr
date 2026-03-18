import request from 'supertest';
import { jest } from '@jest/globals';
import { app } from '../src/app';
import { GitHubClient } from '../src/github';
import { Orchestrator } from '../src/orchestrator';

describe('GET /api/status', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('should return status with geminiConnected true when API key is set', async () => {
    process.env.GEMINI_API_KEY = 'fake-key';
    const response = await request(app).get('/api/status');
    expect(response.status).toBe(200);
    expect(response.body.geminiConnected).toBe(true);
  });

  it('should return status with geminiConnected false when API key is missing', async () => {
    delete process.env.GEMINI_API_KEY;
    const response = await request(app).get('/api/status');
    expect(response.status).toBe(200);
    expect(response.body.geminiConnected).toBe(false);
  });
});

describe('POST /api/review', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it('should return 400 if url is missing', async () => {
    const response = await request(app)
      .post('/api/review')
      .send({ pat: 'mock-pat' });
    
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('GitHub PR URL and PAT are required.');
  });

  it('should return 400 if pat is missing', async () => {
    const response = await request(app)
      .post('/api/review')
      .send({ url: 'https://github.com/owner/repo/pull/1' });
    
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('GitHub PR URL and PAT are required.');
  });

  it('should stream review progress and complete response', async () => {
    const mockChunks = [{ file: 'test.js', content: 'diff' }];
    const mockFindings = [{ file: 'test.js', line: 1, severity: 'HIGH' as const, summary: 'Issue', description: 'Desc', agent: 'Logic' }];

    const getPRDiffSpy = jest.spyOn(GitHubClient.prototype, 'getPRDiff').mockResolvedValue(mockChunks);
    const runReviewSpy = jest.spyOn(Orchestrator.prototype, 'runReview').mockImplementation(async function (this: any, chunks) {
      if (this.onProgress) {
        this.onProgress('Logic', 'test.js', 'start');
        this.onProgress('Logic', 'test.js', 'complete');
      }
      return { findings: mockFindings, metrics: { inputTokens: 0, outputTokens: 0, calls: 0 } };

    });

    const response = await request(app)
      .post('/api/review')
      .send({ url: 'https://github.com/owner/repo/pull/1', pat: 'mock-pat' });

    expect(response.status).toBe(200);
    expect(getPRDiffSpy).toHaveBeenCalledWith('https://github.com/owner/repo/pull/1');
    expect(runReviewSpy).toHaveBeenCalledWith(mockChunks);

    const text = response.text;
    const lines = text.trim().split('\n');
    expect(lines).toHaveLength(3);

    expect(JSON.parse(lines[0])).toEqual({ type: 'progress', agent: 'Logic', file: 'test.js', status: 'start' });
    expect(JSON.parse(lines[1])).toEqual({ type: 'progress', agent: 'Logic', file: 'test.js', status: 'complete' });
    expect(JSON.parse(lines[2])).toEqual({
      type: 'done',
      findings: mockFindings,
      metrics: { inputTokens: 0, outputTokens: 0, calls: 0 }
    });

  });

  it('should return 500 if GitHubClient throws an error', async () => {
    jest.spyOn(GitHubClient.prototype, 'getPRDiff').mockRejectedValue(new Error('GitHub Error'));

    const response = await request(app)
      .post('/api/review')
      .send({ url: 'https://github.com/owner/repo/pull/1', pat: 'mock-pat' });

    expect(response.status).toBe(500);
    expect(response.body.error).toBe('GitHub Error');
  });

  it('should stream error if Orchestrator throws after headers sent', async () => {
    const mockChunks = [{ file: 'test.js', content: 'diff' }];
    jest.spyOn(GitHubClient.prototype, 'getPRDiff').mockResolvedValue(mockChunks);
    jest.spyOn(Orchestrator.prototype, 'runReview').mockRejectedValue(new Error('Orchestrator Error'));

    const response = await request(app)
      .post('/api/review')
      .send({ url: 'https://github.com/owner/repo/pull/1', pat: 'mock-pat' });

    expect(response.status).toBe(200);
    const text = response.text;
    const lines = text.trim().split('\n');
    console.log('DUMP LINES:', lines);

    const lastLine = JSON.parse(lines[lines.length - 1]);
    expect(lastLine).toEqual({ type: 'error', error: 'Orchestrator Error' });
  });
});

