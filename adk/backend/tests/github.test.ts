import { GitHubClient } from '../src/github';
import { jest } from '@jest/globals';


describe('GitHubClient', () => {
    let client: GitHubClient;

    beforeEach(() => {
        client = new GitHubClient('mock-pat');
    });

    it('should successfully parse a valid PR URL', () => {
        const url = 'https://github.com/GoogleCloudPlatform/scion/pull/123';
        const result = client.parsePRUrl(url);

        expect(result).toEqual({
            owner: 'GoogleCloudPlatform',
            repo: 'scion',
            pull_number: 123
        });
    });

    it('should throw an error for an invalid PR URL', () => {
        const url = 'https://github.com/GoogleCloudPlatform/scion/issues/123';
        expect(() => client.parsePRUrl(url)).toThrow('Invalid GitHub Pull Request URL.');
    });

    it('should fetch and parse PR diff successfully', async () => {
        const mockDiff = `
diff --git a/src/example.ts b/src/example.ts
index e69de29..d95f3ad 100644
--- a/src/example.ts
+++ b/src/example.ts
@@ -0,0 +1,3 @@
+export function test() {
+  console.log("hello");
+}
        `.trim();

        (client as any).octokit = {
            paginate: (jest.fn() as any).mockResolvedValue([{ filename: 'src/example.ts', patch: mockDiff }]),
            rest: {
                pulls: {
                    get: (jest.fn() as any).mockResolvedValue({ data: mockDiff }),
                    listFiles: jest.fn()
                }
            }
        };

        const chunks = await client.getPRDiff('https://github.com/GoogleCloudPlatform/scion/pull/123');
        
        expect(chunks).toHaveLength(1);
        expect(chunks[0].file).toBe('src/example.ts');
    });

    it('should throw an error if fetching PR diff fails', async () => {
        const originalConsoleError = console.error;
        console.error = jest.fn(); 

        (client as any).octokit = {
            paginate: (jest.fn() as any).mockRejectedValue(new Error('Network error')),
            rest: {
                pulls: {
                    get: (jest.fn() as any).mockRejectedValue(new Error('Network error')),
                    listFiles: jest.fn()
                }
            }
        };

        await expect(client.getPRDiff('https://github.com/GoogleCloudPlatform/scion/pull/123'))
            .rejects.toThrow('Failed to fetch PR diff: Network error');

        console.error = originalConsoleError;
    });

    describe('postReviewComments', () => {
        const url = 'https://github.com/GoogleCloudPlatform/scion/pull/123';

        it('posts a no-findings summary review when there are no findings', async () => {
            const createReview = (jest.fn() as any).mockResolvedValue({});
            (client as any).octokit = { rest: { pulls: { createReview } } };

            const result = await client.postReviewComments(url, []);

            expect(createReview).toHaveBeenCalledTimes(1);
            expect(createReview.mock.calls[0][0]).toMatchObject({ event: 'COMMENT' });
            expect(createReview.mock.calls[0][0].body).toContain('no issues found');
            expect(result).toEqual({ posted: 0, skipped: 0 });
        });

        it('submits all findings as a single batched review on success', async () => {
            const createReview = (jest.fn() as any).mockResolvedValue({});
            (client as any).octokit = { rest: { pulls: { createReview } } };

            const findings: any = [
                { file: 'src/a.ts', line: 10, severity: 'HIGH', summary: 'issue A', description: 'desc A' },
                { file: 'src/b.ts', line: 20, severity: 'LOW', summary: 'issue B', description: 'desc B' }
            ];

            const result = await client.postReviewComments(url, findings);

            expect(createReview).toHaveBeenCalledTimes(1);
            const call = createReview.mock.calls[0][0];
            expect(call.comments).toHaveLength(2);
            expect(call.comments[0]).toMatchObject({ path: 'src/a.ts', line: 10, side: 'RIGHT' });
            expect(result).toEqual({ posted: 2, skipped: 0 });
        });

        it('falls back to per-comment posting when the batched review is rejected', async () => {
            const createReview = (jest.fn() as any).mockRejectedValue(new Error('line must be part of the diff'));
            const get = (jest.fn() as any).mockResolvedValue({ data: { head: { sha: 'abc123' } } });
            const createReviewComment = (jest.fn() as any)
                .mockResolvedValueOnce({})
                .mockRejectedValueOnce(new Error('not part of the diff'));
            const createComment = (jest.fn() as any).mockResolvedValue({});

            (client as any).octokit = {
                rest: {
                    pulls: { createReview, get, createReviewComment },
                    issues: { createComment }
                }
            };

            const originalWarn = console.warn;
            console.warn = jest.fn();

            const findings: any = [
                { file: 'src/a.ts', line: 10, severity: 'HIGH', summary: 'issue A', description: 'desc A' },
                { file: 'src/b.ts', line: 999, severity: 'LOW', summary: 'issue B', description: 'desc B' }
            ];

            const result = await client.postReviewComments(url, findings);

            console.warn = originalWarn;

            expect(get).toHaveBeenCalledTimes(1);
            expect(createReviewComment).toHaveBeenCalledTimes(2);
            expect(createReviewComment.mock.calls[0][0]).toMatchObject({ commit_id: 'abc123', path: 'src/a.ts', line: 10 });
            expect(createComment).toHaveBeenCalledTimes(1);
            expect(createComment.mock.calls[0][0].body).toContain('1 finding(s) could not be placed inline');
            expect(result).toEqual({ posted: 1, skipped: 1 });
        });
    });

});

