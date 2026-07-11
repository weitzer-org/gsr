import { jest, expect, describe, it, afterEach, beforeEach, beforeAll } from '@jest/globals';
import request from 'supertest';

const spawnMock = jest.fn();
const execMock = jest.fn();

jest.unstable_mockModule('../src/cmd.js', () => ({
  spawn: spawnMock,
  exec: execMock
}));

const listFilesMock = jest.fn<any>();
const getFileStreamMock = jest.fn<any>();
const uploadJsonMock = jest.fn<any>();

jest.unstable_mockModule('../src/storage.js', () => ({
  uploadJson: uploadJsonMock,
  listFiles: listFilesMock,
  getFileStream: getFileStreamMock
}));

class MockStream {
    data: string;
    on(event: string, cb: any) { return this; }
    pipe(res: any) { res.send(JSON.parse(this.data)); }
    constructor(data: string) { this.data = data; }
}

describe('Review History API Endpoints', () => {
  let app: any;

  beforeAll(() => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  beforeEach(async () => {
    jest.resetModules();
    listFilesMock.mockReset();
    getFileStreamMock.mockReset();
    uploadJsonMock.mockReset();

    const mod = await import('../src/app.js');
    app = mod.app;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /api/review/history', () => {
    it('should return a JSON list of stored review files', async () => {
      const mockFile = {
        name: 'review-run_2026-03-24T20-00-00-000Z_test.json',
        updated: '2026-03-24T20:00:00.000Z',
        size: 100,
        metadata: { originalUrl: undefined }
      } as any;
      listFilesMock.mockResolvedValue([mockFile]);

      const response = await request(app).get('/api/review/history');

      expect(response.status).toBe(200);
      expect(response.body).toEqual([{
        name: 'review-run_2026-03-24T20-00-00-000Z_test.json',
        updated: '2026-03-24T20:00:00.000Z',
        size: 100
      }]);
      expect(listFilesMock).toHaveBeenCalledWith('gsr-review-results', 'review-run_', { maxResults: 100, includeMetadata: true });
    });

    it('should return 500 when storage fetch fails', async () => {
      listFilesMock.mockRejectedValue(new Error('Storage failure'));
      const response = await request(app).get('/api/review/history');
      expect(response.status).toBe(500);
    });
  });

  describe('GET /api/review/history/:id', () => {
    const mockReport = { findings: [], metrics: {} };
    const fileId = 'review-run_2024-03-20.json';

    it('should return a specific review object stream when valid', async () => {
       getFileStreamMock.mockResolvedValue(new MockStream(JSON.stringify(mockReport)));

      const response = await request(app).get(`/api/review/history/${fileId}`);

      expect(response.status).toBe(200);
      expect(response.body).toEqual(mockReport);
    });

    it('should return 400 when invalid identifier used (Path Traversal)', async () => {
      const response = await request(app).get('/api/review/history/..%2F..%2F..%2Fetc%2Fpasswd');
      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'Invalid file ID format.' });
    });
  });
});
