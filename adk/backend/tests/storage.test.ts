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

describe('listFiles', () => {
    beforeEach(() => {
        mockSend.mockReset();
    });

    // Regression test for a real production bug (2026-08-30): listFiles made
    // a single ListObjectsV2 call with no pagination loop, so any prefix
    // matching more than S3/R2's 1000-key-per-response cap silently dropped
    // everything past the first page — usage.ts's listUsageRecords (the only
    // caller that omits maxResults) undercounted every high-volume day with
    // no error at all.
    it('follows ContinuationToken across multiple pages when maxResults is omitted', async () => {
        mockSend
            .mockResolvedValueOnce({
                Contents: [{ Key: 'usage/2026-08-29/a.json' }, { Key: 'usage/2026-08-29/b.json' }],
                IsTruncated: true,
                NextContinuationToken: 'token-1',
            })
            .mockResolvedValueOnce({
                Contents: [{ Key: 'usage/2026-08-29/c.json' }],
                IsTruncated: false,
            });

        const files = await storage.listFiles('bucket', 'usage/2026-08-29/');

        expect(files.map(f => f.name)).toEqual(['usage/2026-08-29/a.json', 'usage/2026-08-29/b.json', 'usage/2026-08-29/c.json']);
        expect(mockSend).toHaveBeenCalledTimes(2);
        // Second call must actually pass the continuation token forward.
        const secondCallInput = mockSend.mock.calls[1][0] as any;
        expect(secondCallInput.ContinuationToken).toBe('token-1');
    });

    it('stops after one page when the result is not truncated', async () => {
        mockSend.mockResolvedValueOnce({ Contents: [{ Key: 'usage/2026-08-29/a.json' }], IsTruncated: false });

        const files = await storage.listFiles('bucket', 'usage/2026-08-29/');

        expect(files).toHaveLength(1);
        expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it('does NOT paginate past the requested page when maxResults is explicitly set', async () => {
        // Recent-history UI views (feedback.ts, app.ts's eval-run/review-run
        // listings) intentionally want a bounded page, not "everything" —
        // a truncated result here must not trigger a second call.
        mockSend.mockResolvedValueOnce({
            Contents: [{ Key: 'review-run_1.json' }],
            IsTruncated: true,
            NextContinuationToken: 'token-1',
        });

        const files = await storage.listFiles('bucket', 'review-run_', { maxResults: 100 });

        expect(files).toHaveLength(1);
        expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it('filters out a Contents entry exactly equal to the prefix itself', async () => {
        mockSend.mockResolvedValueOnce({
            Contents: [{ Key: 'usage/2026-08-29/' }, { Key: 'usage/2026-08-29/a.json' }],
            IsTruncated: false,
        });

        const files = await storage.listFiles('bucket', 'usage/2026-08-29/');

        expect(files.map(f => f.name)).toEqual(['usage/2026-08-29/a.json']);
    });
});
