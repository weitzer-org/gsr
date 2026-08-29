import { jest, describe, it, expect, beforeAll, beforeEach } from '@jest/globals';

const mockUploadJson = jest.fn<any>().mockResolvedValue(undefined);
const mockListFiles = jest.fn<any>();
const mockGetFileStream = jest.fn<any>();

// Same ESM-mocking pattern as usage.test.ts — src/storage.js must be mocked
// before src/feedback.js is imported.
jest.unstable_mockModule('../src/storage.js', () => ({
    uploadJson: mockUploadJson,
    listFiles: mockListFiles,
    getFileStream: mockGetFileStream,
    getFileJson: jest.fn(),
}));

let feedback: typeof import('../src/feedback.js');

beforeAll(async () => {
    feedback = await import('../src/feedback.js');
});

beforeEach(() => {
    mockUploadJson.mockClear();
    mockListFiles.mockClear();
    mockGetFileStream.mockClear();
});

const validItem = () => ({
    findingId: 'abc123', file: 'src/x.ts', line: 10, severity: 'HIGH', agent: 'Logic',
    summary: 'a real problem', reviewUrl: 'https://github.com/o/r/pull/1',
    verdict: 'valid', comment: 'confirmed, thanks', submittedBy: 'claude-code',
});

describe('validateFeedbackItem', () => {
    it('accepts a minimal valid item', () => {
        const result = feedback.validateFeedbackItem(validItem());
        expect(result.ok).toBe(true);
    });

    it('accepts an item missing reviewUrl when a batch-level default is provided', () => {
        const { reviewUrl, ...rest } = validItem();
        const result = feedback.validateFeedbackItem(rest, 'https://github.com/o/r/pull/2');
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.value.reviewUrl).toBe('https://github.com/o/r/pull/2');
    });

    it('rejects an item missing reviewUrl with no batch-level default either', () => {
        const { reviewUrl, ...rest } = validItem();
        const result = feedback.validateFeedbackItem(rest);
        expect(result.ok).toBe(false);
    });

    for (const field of ['findingId', 'file', 'severity', 'agent', 'summary', 'comment', 'submittedBy']) {
        it(`rejects a missing required string field: ${field}`, () => {
            const item: any = validItem();
            delete item[field];
            expect(feedback.validateFeedbackItem(item).ok).toBe(false);
        });
    }

    it('rejects a non-numeric line', () => {
        const item: any = validItem();
        item.line = 'ten';
        expect(feedback.validateFeedbackItem(item).ok).toBe(false);
    });

    it('rejects an invalid verdict', () => {
        const item: any = validItem();
        item.verdict = 'maybe';
        expect(feedback.validateFeedbackItem(item).ok).toBe(false);
    });

    it('rejects a comment over the 4KB cap', () => {
        const item: any = validItem();
        item.comment = 'x'.repeat(4001);
        expect(feedback.validateFeedbackItem(item).ok).toBe(false);
    });

    it('accepts a comment right at the 4KB cap', () => {
        const item: any = validItem();
        item.comment = 'x'.repeat(4000);
        expect(feedback.validateFeedbackItem(item).ok).toBe(true);
    });

    it('rejects exampleCodeBefore over the 32KB cap', () => {
        const item: any = validItem();
        item.exampleCodeBefore = 'x'.repeat(32001);
        expect(feedback.validateFeedbackItem(item).ok).toBe(false);
    });

    it('accepts optional code/feedback fields within their caps', () => {
        const item: any = validItem();
        item.exampleCodeBefore = 'before';
        item.exampleCodeAfter = 'after';
        item.codeFeedback = 'the fix missed a case';
        item.promptVersion = 'system_prompts';
        const result = feedback.validateFeedbackItem(item);
        expect(result.ok).toBe(true);
    });

    it('rejects an invalid source', () => {
        const item: any = validItem();
        item.source = 'carrier-pigeon';
        expect(feedback.validateFeedbackItem(item).ok).toBe(false);
    });

    it('accepts pr-thread source with a well-formed adjudication', () => {
        const item: any = validItem();
        item.source = 'pr-thread';
        item.threadUrl = 'https://github.com/o/r/pull/1#discussion_r1';
        item.stance = 'rejected';
        item.adjudication = { verdict: 'pushback_incorrect', confidence: 0.9, reasoning: 'the diff still has the bug' };
        const result = feedback.validateFeedbackItem(item);
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.value.adjudication?.verdict).toBe('pushback_incorrect');
    });

    it('rejects a malformed adjudication.verdict', () => {
        const item: any = validItem();
        item.adjudication = { verdict: 'nonsense', confidence: 0.9, reasoning: 'x' };
        expect(feedback.validateFeedbackItem(item).ok).toBe(false);
    });

    it('rejects a non-object item', () => {
        expect(feedback.validateFeedbackItem('nope').ok).toBe(false);
        expect(feedback.validateFeedbackItem(null).ok).toBe(false);
    });
});

describe('ingestFeedbackBody', () => {
    it('accepts a single object (not batched)', async () => {
        const result: any = await feedback.ingestFeedbackBody(validItem());
        expect(result.accepted).toBe(1);
        expect(result.rejected).toBe(0);
        expect(mockUploadJson).toHaveBeenCalledTimes(1);
    });

    it('accepts a batch and applies the shared reviewUrl to items missing one', async () => {
        const { reviewUrl, ...itemNoUrl } = validItem();
        const result: any = await feedback.ingestFeedbackBody({
            reviewUrl: 'https://github.com/o/r/pull/9',
            items: [validItem(), itemNoUrl],
        });
        expect(result.accepted).toBe(2);
        expect(mockUploadJson).toHaveBeenCalledTimes(2);
    });

    it('isolates a malformed item in a batch instead of rejecting the whole batch', async () => {
        const result: any = await feedback.ingestFeedbackBody({
            reviewUrl: 'https://github.com/o/r/pull/9',
            items: [validItem(), { findingId: 'only-this-field' }],
        });
        expect(result.accepted).toBe(1);
        expect(result.rejected).toBe(1);
        expect(result.errors).toHaveLength(1);
        expect(mockUploadJson).toHaveBeenCalledTimes(1);
    });

    it('rejects an empty items array', async () => {
        const result: any = await feedback.ingestFeedbackBody({ reviewUrl: 'x', items: [] });
        expect('error' in result).toBe(true);
    });

    it('rejects a batch over the item cap', async () => {
        const items = Array.from({ length: 51 }, () => validItem());
        const result: any = await feedback.ingestFeedbackBody({ reviewUrl: 'x', items });
        expect('error' in result).toBe(true);
        expect(mockUploadJson).not.toHaveBeenCalled();
    });

    it('rejects a non-object body', async () => {
        const result: any = await feedback.ingestFeedbackBody(null);
        expect('error' in result).toBe(true);
    });

    it('the written record carries a server-assigned submittedAt, ignoring any caller-provided value', async () => {
        await feedback.ingestFeedbackBody({ ...validItem(), submittedAt: '1999-01-01T00:00:00.000Z' });
        const [, , written] = mockUploadJson.mock.calls[0] as [string, string, any];
        expect(written.submittedAt).not.toBe('1999-01-01T00:00:00.000Z');
        expect(new Date(written.submittedAt).toString()).not.toBe('Invalid Date');
    });

    // Security-review finding: unlike the PR-comment loop's own findingId
    // scheme (a 16-hex-char content hash), this general-purpose endpoint
    // accepts an arbitrary caller-supplied findingId up to MAX_SHORT_FIELD_LEN
    // — an unsanitized, overlong value interpolated straight into the S3
    // object key could exceed S3's 1024-byte key limit or embed characters
    // (slashes, control characters) that produce a malformed key.
    it('sanitizes and bounds the S3 key even for an adversarial findingId/reviewUrl, without truncating the stored record', async () => {
        const item = {
            ...validItem(),
            findingId: '../../etc/passwd' + 'x'.repeat(500),
            reviewUrl: 'https://example.test/pull/1' + 'y'.repeat(500),
        };
        await feedback.ingestFeedbackBody(item);

        const [, key, written] = mockUploadJson.mock.calls[0] as [string, string, any];
        expect(key.length).toBeLessThan(300); // well under S3's 1024-byte key cap
        expect(key).not.toContain('/../');
        expect(key.startsWith('feedback_')).toBe(true);
        // The stored record itself keeps the full, untruncated values.
        expect(written.findingId).toBe(item.findingId);
        expect(written.reviewUrl).toBe(item.reviewUrl);
    });
});

describe('listFeedbackFiles / getFeedbackRecordStream', () => {
    it('lists under the feedback_ prefix', async () => {
        mockListFiles.mockResolvedValue([{ name: 'feedback_x.json' }]);
        const files = await feedback.listFeedbackFiles();
        expect(files).toHaveLength(1);
        expect(mockListFiles).toHaveBeenCalledWith(expect.any(String), 'feedback_', expect.any(Object));
    });

    it('streams a record by key', async () => {
        mockGetFileStream.mockResolvedValue('a-stream' as any);
        const stream = await feedback.getFeedbackRecordStream('feedback_x.json');
        expect(stream).toBe('a-stream');
    });
});
