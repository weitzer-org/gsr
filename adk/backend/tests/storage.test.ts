import { jest, describe, it, expect, beforeAll, beforeEach } from '@jest/globals';
import { Readable } from 'stream';

const mockSend = jest.fn<any>();

// ESM modules are resolved/evaluated before a hoisted classic jest.mock()
// can apply — mock @aws-sdk/client-s3 via jest.unstable_mockModule and
// dynamically import src/storage.js afterward, mirroring usage.test.ts's
// proven pattern for this repo's ESM jest config. Only getFileJson's
// corrupted-JSON handling is covered here (the fix for a real bug: JSON.parse
// used to run outside the try/catch, turning a corrupted cached rollup into
// a hard failure instead of a self-healing cache miss) — the rest of
// storage.ts is exercised indirectly everywhere else it's mocked as a whole.
jest.unstable_mockModule('@aws-sdk/client-s3', () => ({
    S3Client: jest.fn().mockImplementation(() => ({ send: mockSend })),
    GetObjectCommand: jest.fn((input: unknown) => input),
    PutObjectCommand: jest.fn((input: unknown) => input),
    ListObjectsV2Command: jest.fn((input: unknown) => input),
    HeadObjectCommand: jest.fn((input: unknown) => input),
}));

let storage: typeof import('../src/storage.js');

beforeAll(async () => {
    storage = await import('../src/storage.js');
});

describe('getFileJson', () => {
    beforeEach(() => {
        mockSend.mockReset();
    });

    it('parses and returns valid JSON', async () => {
        mockSend.mockResolvedValue({ Body: Readable.from(['{"a":1}']) });
        await expect(storage.getFileJson('bucket', 'key')).resolves.toEqual({ a: 1 });
    });

    it('returns undefined for a missing key instead of throwing', async () => {
        mockSend.mockRejectedValue(Object.assign(new Error('not found'), { name: 'NoSuchKey' }));
        await expect(storage.getFileJson('bucket', 'key')).resolves.toBeUndefined();
    });

    it('returns undefined for corrupted/unparsable JSON instead of throwing', async () => {
        mockSend.mockResolvedValue({ Body: Readable.from(['{not valid json']) });
        await expect(storage.getFileJson('bucket', 'key')).resolves.toBeUndefined();
    });

    it('rethrows a real S3 transport/auth error', async () => {
        mockSend.mockRejectedValue(Object.assign(new Error('access denied'), { name: 'AccessDenied' }));
        await expect(storage.getFileJson('bucket', 'key')).rejects.toThrow(/access denied/i);
    });
});
