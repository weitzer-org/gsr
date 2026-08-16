import { jest, describe, it, expect } from '@jest/globals';
import { reportFeedback } from '../src/feedbackReporter';
import { FindingFeedback } from '../src/types';

const oneRecord: Omit<FindingFeedback, 'submittedAt'> = {
    findingId: 'abc123', file: 'src/x.ts', line: 10, severity: 'HIGH', agent: 'Logic',
    summary: 'summary', reviewUrl: 'https://github.com/o/r/pull/1', verdict: 'valid',
    comment: 'looks right', submittedBy: 'gsr-feedback-loop',
};

describe('reportFeedback', () => {
    it('POSTs each batch with the expected URL/header/body', async () => {
        const fetchImpl = jest.fn<any>().mockResolvedValue({ ok: true, status: 200 });

        const result = await reportFeedback([oneRecord, oneRecord, oneRecord], {
            url: 'https://gsr-code-review.fly.dev/api/findings/feedback',
            key: 'secret-key',
            reviewUrl: 'https://github.com/o/r/pull/1',
            batchSize: 2,
            fetchImpl: fetchImpl as any,
        });

        expect(result).toEqual({ batchesSent: 2, batchesFailed: 0 });
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        const [url, init] = fetchImpl.mock.calls[0] as [string, any];
        expect(url).toBe('https://gsr-code-review.fly.dev/api/findings/feedback');
        expect(init.method).toBe('POST');
        expect(init.headers['X-Feedback-Key']).toBe('secret-key');
        const body = JSON.parse(init.body);
        expect(body.reviewUrl).toBe('https://github.com/o/r/pull/1');
        expect(body.items).toHaveLength(2);
    });

    it('does not let one failed batch stop the rest, and never throws', async () => {
        const fetchImpl = jest.fn<any>()
            .mockResolvedValueOnce({ ok: false, status: 500 })
            .mockResolvedValueOnce({ ok: true, status: 200 });
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

        const result = await reportFeedback([oneRecord, oneRecord], {
            url: 'https://example.test/api/findings/feedback',
            key: 'k',
            reviewUrl: 'https://github.com/o/r/pull/1',
            batchSize: 1,
            fetchImpl: fetchImpl as any,
        });

        expect(result).toEqual({ batchesSent: 1, batchesFailed: 1 });
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        warnSpy.mockRestore();
    });

    it('treats a rejected fetch as a failed batch rather than throwing', async () => {
        const fetchImpl = jest.fn<any>().mockRejectedValue(new Error('network down'));
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

        await expect(
            reportFeedback([oneRecord], {
                url: 'https://example.test/api/findings/feedback',
                key: 'k',
                reviewUrl: 'https://github.com/o/r/pull/1',
                fetchImpl: fetchImpl as any,
            })
        ).resolves.toEqual({ batchesSent: 0, batchesFailed: 1 });

        warnSpy.mockRestore();
    });
});
