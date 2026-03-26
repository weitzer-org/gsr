import { jest, expect, describe, it, afterEach, beforeEach, beforeAll } from '@jest/globals';
import request from 'supertest';

const spawnMock = jest.fn();
const execMock = jest.fn();

jest.unstable_mockModule('../src/cmd.js', () => ({
  spawn: spawnMock,
  exec: execMock
}));

const getFilesMock = jest.fn<any>();
const createReadStreamMock = jest.fn<any>();
const bucketMock = jest.fn<any>(() => ({
  getFiles: getFilesMock,
  file: jest.fn(() => ({
    createReadStream: createReadStreamMock
  }))
}));

jest.unstable_mockModule('@google-cloud/storage', () => ({
  Storage: jest.fn(() => ({
    bucket: bucketMock
  }))
}));

class MockStream {
    data: string;
    on(event: string, cb: any) { return this; }
    pipe(res: any) { res.send(JSON.parse(this.data)); }
    constructor(data: string) { this.data = data; }
}

describe('Evaluations API Endpoints', () => {
  let app: any;

  beforeAll(() => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  beforeEach(async () => {
    jest.resetModules();
    spawnMock.mockReset();
    execMock.mockReset();
    getFilesMock.mockReset();
    createReadStreamMock.mockReset();

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

      const response = await request(app)
        .post('/api/evals/start')
        .send({ comparisonGroup: 'local_vs_evals', branchName: 'evals' });

      expect(response.status).toBe(202);
      expect(response.body).toEqual({
        status: 'started',
        message: 'Evaluation harness is running in the background.'
      });

      expect(spawnMock).toHaveBeenCalledWith('npm', ['run', 'eval', '--', '--use-new-metrics'], expect.objectContaining({
        detached: true,
        stdio: 'inherit',
      }));
      expect(mockChild.unref).toHaveBeenCalled();
    });
  });

  describe('GET /api/evals/results', () => {
    it('should return a JSON list of GCS files', async () => {
      getFilesMock.mockResolvedValue([
        [
          { name: 'eval-run_202x.json', metadata: { updated: '2026', size: '10' } }
        ]
      ]);

      const response = await request(app).get('/api/evals/results');

      expect(response.status).toBe(200);
      expect(response.body).toEqual([{ name: 'eval-run_202x.json', updated: '2026', size: '10' }]);
      expect(getFilesMock).toHaveBeenCalledWith({ prefix: 'eval-run_', autoPaginate: false, maxResults: 100 });
    });

    it('should return 500 when storage fetch fails', async () => {
      getFilesMock.mockRejectedValue(new Error('Storage failure'));
      const response = await request(app).get('/api/evals/results');
      expect(response.status).toBe(500);
    });
  });

  describe('GET /api/evals/results/:id', () => {
    const mockReport = { aggregate: true, comparisons: [] };
    const fileId = 'eval-run_2024-03-20.json';

    it('should return a specific eval object stream when valid', async () => {
       createReadStreamMock.mockReturnValue(new MockStream(JSON.stringify(mockReport)));

      const response = await request(app).get(`/api/evals/results/${fileId}`);

      expect(response.status).toBe(200);
      expect(response.body).toEqual(mockReport);
    });

    it('should return 400 when invalid identifier used (Path Traversal)', async () => {
      const response = await request(app).get('/api/evals/results/..%2F..%2F..%2Fetc%2Fpasswd');
      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'Invalid file ID format.' });
    });
  });
});
