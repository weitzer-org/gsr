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
const saveMock = jest.fn<any>();
const getMetadataMock = jest.fn<any>();

const bucketMock = jest.fn<any>(() => ({
  getFiles: getFilesMock,
  file: jest.fn(() => ({
    createReadStream: createReadStreamMock,
    save: saveMock,
    getMetadata: getMetadataMock
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

describe('Review History API Endpoints', () => {
  let app: any;

  beforeAll(() => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  beforeEach(async () => {
    jest.resetModules();
    getFilesMock.mockReset();
    createReadStreamMock.mockReset();
    saveMock.mockReset();
    getMetadataMock.mockReset();

    const mod = await import('../src/app.js');
    app = mod.app;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /api/review/history', () => {
    it('should return a JSON list of GCS files', async () => {
      // Mock the file list returned from getFiles
      const mockFile = {
        name: 'review-run_2026-03-24T20-00-00-000Z_test.json',
        metadata: { updated: '2026-03-24T20:00:00.000Z', size: 100 }
      } as any;
      getFilesMock.mockResolvedValue([[mockFile]]);

      const response = await request(app).get('/api/review/history');

      expect(response.status).toBe(200);
      expect(response.body).toEqual([{ 
        name: 'review-run_2026-03-24T20-00-00-000Z_test.json', 
        updated: '2026-03-24T20:00:00.000Z', 
        size: 100 
      }]);
      expect(getFilesMock).toHaveBeenCalledWith({ prefix: 'review-run_', autoPaginate: false, maxResults: 100 });
    });

    it('should return 500 when storage fetch fails', async () => {
      getFilesMock.mockRejectedValue(new Error('Storage failure'));
      const response = await request(app).get('/api/review/history');
      expect(response.status).toBe(500);
    });
  });

  describe('GET /api/review/history/:id', () => {
    const mockReport = { findings: [], metrics: {} };
    const fileId = 'review-run_2024-03-20.json';

    it('should return a specific review object stream when valid', async () => {
       createReadStreamMock.mockReturnValue(new MockStream(JSON.stringify(mockReport)));

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
