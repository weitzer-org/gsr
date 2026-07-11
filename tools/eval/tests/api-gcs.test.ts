import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';

jest.mock('../storage');

import { main } from '../api-gcs';
import * as storage from '../storage';

const mockListFiles = storage.listFiles as jest.Mock;
const mockDownloadFile = storage.downloadFile as jest.Mock;

describe('api-gcs script', () => {
  let consoleLogSpy: any;

  beforeEach(() => {
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    process.env.S3_BUCKET = 'gsr-eval-results-test-project-id';

    mockListFiles.mockReset();
    mockDownloadFile.mockReset();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('list action', () => {
    it('should list all eval runs sorted by date descending', async () => {
      const mockFiles = [
        { name: 'eval-run_1', updated: '2026-03-21T00:00:00.000Z', size: 1024 },
        { name: 'eval-run_2', updated: '2026-03-22T00:00:00.000Z', size: 2048 }
      ];

      // @ts-ignore
      mockListFiles.mockResolvedValue(mockFiles);

      await main(['list']);

      expect(mockListFiles).toHaveBeenCalledWith('gsr-eval-results-test-project-id', 'eval-run_');

      const expectedOutput = JSON.stringify([
        { name: 'eval-run_2', updated: '2026-03-22T00:00:00.000Z', size: 2048 },
        { name: 'eval-run_1', updated: '2026-03-21T00:00:00.000Z', size: 1024 }
      ]);
      expect(consoleLogSpy).toHaveBeenCalledWith(expectedOutput);
    });
  });

  describe('get action', () => {
    it('should fetch the contents of a specific file', async () => {
      // @ts-ignore
      mockDownloadFile.mockResolvedValue('{"data": "file_contents"}');

      const testFilename = 'eval-run_my_run.json';
      await main(['get', testFilename]);

      expect(mockDownloadFile).toHaveBeenCalledWith('gsr-eval-results-test-project-id', testFilename);
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
