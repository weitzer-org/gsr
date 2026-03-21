import { jest, expect, describe, it, afterEach, beforeEach } from '@jest/globals';
import request from 'supertest';

const spawnMock = jest.fn();
const execMock = jest.fn();

jest.unstable_mockModule('../src/cmd.js', () => ({
  spawn: spawnMock,
  exec: execMock
}));

describe('Evaluations API Endpoints', () => {
  let app: any;

  beforeEach(async () => {
    jest.resetModules();
    spawnMock.mockReset();
    execMock.mockReset();

    const mod = await import('../src/app.js');
    app = mod.app;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /api/evals/start', () => {
    it('should spawn the eval process detached and return 202', async () => {
      const mockChild = { unref: jest.fn() };
      spawnMock.mockReturnValue(mockChild);

      const response = await request(app).post('/api/evals/start').send({
        comparisonGroup: 'local_vs_branch',
        branchName: 'dummy-feat'
      });

      expect(response.status).toBe(202);
      expect(response.body).toEqual({
        status: 'started',
        message: 'Evaluation harness is running in the background.'
      });
      expect(spawnMock).toHaveBeenCalledWith(
        'npm',
        ['run', 'eval'],
        expect.objectContaining({
          detached: true,
          stdio: 'inherit',
          env: expect.objectContaining({
            EVAL_COMPARISON_GROUP: 'local_vs_branch',
            EVAL_TARGET_BRANCH: 'dummy-feat'
          })
        })
      );
      expect(mockChild.unref).toHaveBeenCalled();
    });

    it('should return 400 when comparisonGroup is branch reliant but branchName is missing', async () => {
      const response = await request(app).post('/api/evals/start').send({
        comparisonGroup: 'local_vs_branch',
        branchName: ''
      });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        error: 'branchName is required when comparison group involves a branch.'
      });
      expect(spawnMock).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/evals/results', () => {
    it('should return a parsed JSON list on successful exec', async () => {
      const mockResult = [{ name: 'eval-run_2026-03-21T00.json', updated: '2026-03-21T00:00:00.000Z', size: 1024 }];
      
      execMock.mockImplementation((cmd: any, opts: any, callback: any) => {
        callback(null, JSON.stringify(mockResult), '');
        return {};
      });

      const response = await request(app).get('/api/evals/results');

      expect(response.status).toBe(200);
      expect(response.body).toEqual(mockResult);
      expect(execMock).toHaveBeenCalledWith(
        'npm run --silent eval:list',
        expect.any(Object),
        expect.any(Function)
      );
    });

    it('should return 500 when exec fails', async () => {
      execMock.mockImplementation((cmd: any, opts: any, callback: any) => {
        callback(new Error('Exec failed'), '', 'Some error inside script');
        return {};
      });

      const response = await request(app).get('/api/evals/results');

      expect(response.status).toBe(500);
      expect(response.body).toHaveProperty('error', 'Exec failed');
    });

    it('should return 500 when JSON parsing fails', async () => {
      execMock.mockImplementation((cmd: any, opts: any, callback: any) => {
        callback(null, 'Invalid JSON string here', '');
        return {};
      });

      const response = await request(app).get('/api/evals/results');

      expect(response.status).toBe(500);
      expect(response.body).toHaveProperty('error', 'Failed to parse list script output');
    });
  });

  describe('GET /api/evals/results/:id', () => {
    it('should return a specific eval object when valid', async () => {
      const mockReport = {
        run_date: '2026-03-21T00:00:00.000Z',
        results: [],
        aggregate_report: 'This is an aggregate report'
      };

      execMock.mockImplementation((cmd: any, opts: any, callback: any) => {
        callback(null, JSON.stringify(mockReport), '');
        return {};
      });

      const fileId = 'eval-run_2026.json';
      const response = await request(app).get(`/api/evals/results/${fileId}`);

      expect(response.status).toBe(200);
      expect(response.body).toEqual(mockReport);
      expect(execMock).toHaveBeenCalledWith(
        `npm run --silent eval:get ${fileId}`,
        expect.any(Object),
        expect.any(Function)
      );
    });

    it('should return 500 when JSON parsing fails on a big payload', async () => {
      execMock.mockImplementation((cmd: any, opts: any, callback: any) => {
        callback(null, 'Partial JSON string { "run_date": "20', '');
        return {};
      });

      const response = await request(app).get('/api/evals/results/my-run.json');

      expect(response.status).toBe(500);
      expect(response.body).toHaveProperty('error', 'Failed to parse get script output');
    });
  });
});
