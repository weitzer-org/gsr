import request from 'supertest';
import { jest } from '@jest/globals';
import { GitHubClient } from '../src/github';
import { Orchestrator } from '../src/orchestrator';
import { Evaluator } from '../src/evaluator';

const uploadJsonMock = jest.fn<any>();

jest.unstable_mockModule('../src/storage.js', () => ({
  uploadJson: uploadJsonMock,
  listFiles: jest.fn(),
  getFileStream: jest.fn()
}));

describe('GET /api/status', () => {
  const originalEnv = process.env;
  let app: any;

  beforeEach(async () => {
    jest.resetModules();
    process.env = { ...originalEnv };
    const mod = await import('../src/app.js');
    app = mod.app;
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
  let app: any;

  beforeEach(async () => {
    jest.resetModules();
    jest.restoreAllMocks();
    process.env.GEMINI_API_KEY = 'fake-key';
    const mod = await import('../src/app.js');
    app = mod.app;
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

    const githubModule = await import('../src/github.js');
    const orchestratorModule = await import('../src/orchestrator.js');
    const evaluatorModule = await import('../src/evaluator.js');

    const getPRDiffSpy = jest.spyOn(githubModule.GitHubClient.prototype, 'getPRDiff').mockResolvedValue(mockChunks);
    const runReviewSpy = jest.spyOn(orchestratorModule.Orchestrator.prototype, 'runReview').mockImplementation(async function (this: any, chunks) {
      if (this.onProgress) {
        this.onProgress('Logic', 'test.js', 'start');
        this.onProgress('Logic', 'test.js', 'complete');
      }
      return { findings: JSON.parse(JSON.stringify(mockFindings)), metrics: { inputTokens: 0, outputTokens: 0, calls: 0 } };
    });
    
    const evaluateComparisonSpy = jest.spyOn(evaluatorModule.Evaluator.prototype, 'evaluateComparison').mockResolvedValue('Mock evaluation string');

    const response = await request(app)
      .post('/api/review')
      .send({ url: 'https://github.com/owner/repo/pull/1', pat: 'mock-pat' });

    expect(response.status).toBe(200);
    expect(getPRDiffSpy).toHaveBeenCalledWith('https://github.com/owner/repo/pull/1');
    expect(runReviewSpy).toHaveBeenCalledWith(mockChunks);
    expect(evaluateComparisonSpy).toHaveBeenCalled();

    const text = response.text;
    const lines = text.trim().split('\n');
    expect(lines).toHaveLength(5);

    expect(JSON.parse(lines[0])).toEqual({ type: 'progress', source: 'subagent', agent: 'Logic', file: 'test.js', status: 'start' });
    expect(JSON.parse(lines[1])).toEqual({ type: 'progress', source: 'subagent', agent: 'Logic', file: 'test.js', status: 'complete' });
    expect(JSON.parse(lines[2])).toEqual({ type: 'progress', source: 'basic', agent: 'Logic', file: 'test.js', status: 'start' });
    expect(JSON.parse(lines[3])).toEqual({ type: 'progress', source: 'basic', agent: 'Logic', file: 'test.js', status: 'complete' });
    
    // Create expectations for findings knowing source was mutated
    const expectedSubagentFindings = JSON.parse(JSON.stringify(mockFindings));
    expectedSubagentFindings[0].source = 'subagent';
    const expectedBasicFindings = JSON.parse(JSON.stringify(mockFindings));
    expectedBasicFindings[0].source = 'basic';

    expect(JSON.parse(lines[4])).toEqual(expect.objectContaining({
      type: 'done',
      url: 'https://github.com/owner/repo/pull/1',
      findings: [...expectedSubagentFindings, ...expectedBasicFindings],
      metrics: {
        inputTokens: 0,
        outputTokens: 0,
        calls: 0,
        subagentMetrics: { inputTokens: 0, outputTokens: 0, calls: 0 },
        basicMetrics: { inputTokens: 0, outputTokens: 0, calls: 0 }
      },
      evaluation: 'Mock evaluation string'
    }));

    expect(JSON.parse(lines[4]).timestamp).toBeDefined();

  });

  it('should return 500 if GitHubClient throws an error', async () => {
    const githubModule = await import('../src/github.js');
    jest.spyOn(githubModule.GitHubClient.prototype, 'getPRDiff').mockRejectedValue(new Error('GitHub Error'));

    const response = await request(app)
      .post('/api/review')
      .send({ url: 'https://github.com/owner/repo/pull/1', pat: 'mock-pat' });

    expect(response.status).toBe(500);
    expect(response.body.error).toBe('GitHub Error');
  });

  it('should stream resilient empty results if Orchestrators throw', async () => {
    const githubModule = await import('../src/github.js');
    const orchestratorModule = await import('../src/orchestrator.js');
    const evaluatorModule = await import('../src/evaluator.js');
    const mockChunks = [{ file: 'test.js', content: 'diff' }];
    
    jest.spyOn(githubModule.GitHubClient.prototype, 'getPRDiff').mockResolvedValue(mockChunks);
    jest.spyOn(orchestratorModule.Orchestrator.prototype, 'runReview').mockRejectedValue(new Error('Orchestrator Error'));
    jest.spyOn(evaluatorModule.Evaluator.prototype, 'evaluateComparison').mockResolvedValue('Mock evaluation');

    const response = await request(app)
      .post('/api/review')
      .send({ url: 'https://github.com/owner/repo/pull/1', pat: 'mock-pat' });

    expect(response.status).toBe(200);
    const text = response.text;
    const lines = text.trim().split('\n');

    const lastLine = JSON.parse(lines[lines.length - 1]);
    expect(lastLine.type).toBe('done');
    expect(lastLine.findings).toEqual([]);
  });
});

