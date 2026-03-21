import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { main } from '../api-gcs';

// Define mocks inside jest.mock so they are not hoisted past initialization
jest.mock('@google-cloud/storage', () => {
  const mockGetFiles = jest.fn();
  const mockDownload = jest.fn();
  const mockFile = jest.fn().mockReturnValue({ download: mockDownload });
  const mockBucket = jest.fn().mockReturnValue({
    getFiles: mockGetFiles,
    file: mockFile
  });

  return {
    Storage: jest.fn().mockImplementation(() => ({
      bucket: mockBucket
    })),
    // Expose for asserting
    _mockGetFiles: mockGetFiles,
    _mockDownload: mockDownload,
    _mockFile: mockFile,
    _mockBucket: mockBucket
  };
});

// Retrieve them from the mock module so tests can use them
import { _mockGetFiles, _mockDownload, _mockFile, _mockBucket } from '@google-cloud/storage';
const mockGetFiles = _mockGetFiles as jest.Mock;
const mockDownload = _mockDownload as jest.Mock;
const mockFile = _mockFile as jest.Mock;
const mockBucket = _mockBucket as jest.Mock;

describe('api-gcs script', () => {
  let consoleLogSpy: any;

  beforeEach(() => {
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    process.env.GOOGLE_APPLICATION_CREDENTIALS = 'fake';
    
    mockGetFiles.mockReset();
    mockDownload.mockReset();
    mockFile.mockClear();
    mockBucket.mockClear();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('list action', () => {
    it('should list all eval runs sorted by date descending', async () => {
      // Mock files returned by storage
      const mockFiles = [
        { name: 'eval-run_2', metadata: { updated: '2026-03-22T00:00:00.000Z', size: 2048 } },
        { name: 'eval-run_1', metadata: { updated: '2026-03-21T00:00:00.000Z', size: 1024 } }
      ];

      mockGetFiles.mockResolvedValue([mockFiles]);

      await main(['list']);

      expect(mockBucket).toHaveBeenCalledWith('gsr-eval-results-weitzer-org');
      expect(mockGetFiles).toHaveBeenCalledWith({ prefix: 'eval-run_' });
      
      const expectedOutput = JSON.stringify([
        { name: 'eval-run_2', updated: '2026-03-22T00:00:00.000Z', size: 2048 },
        { name: 'eval-run_1', updated: '2026-03-21T00:00:00.000Z', size: 1024 }
      ]);
      expect(consoleLogSpy).toHaveBeenCalledWith(expectedOutput);
    });
  });

  describe('get action', () => {
    it('should fetch the contents of a specific file', async () => {
      mockDownload.mockResolvedValue([Buffer.from('{"data": "file_contents"}')]);

      const testFilename = 'eval-run_my_run.json';
      await main(['get', testFilename]);

      expect(mockBucket).toHaveBeenCalledWith('gsr-eval-results-weitzer-org');
      expect(mockFile).toHaveBeenCalledWith(testFilename);
      expect(mockDownload).toHaveBeenCalled();
      expect(consoleLogSpy).toHaveBeenCalledWith('{"data": "file_contents"}');
    });

    it('should throw an error if no filename is provided', async () => {
      await expect(main(['get'])).rejects.toThrow('File name required for get action');
    });
  });

  it('should throw an error on unknown action', async () => {
    await expect(main(['invalid-action'])).rejects.toThrow('Unknown action: invalid-action');
  });
});
