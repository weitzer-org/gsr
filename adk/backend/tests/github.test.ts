import { GitHubClient } from '../src/github';
import { buildFindingMarker, parseFindingMarker } from '../src/findingMarker';
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
            const fallbackBody = createComment.mock.calls[0][0].body;
            expect(fallbackBody).toContain("couldn't be placed inline");
            expect(fallbackBody).toContain('src/b.ts:999');
            expect(fallbackBody).toContain('issue B');
            expect(fallbackBody).toContain('desc B');
            expect(result).toEqual({ posted: 1, skipped: 1 });
        });
    });

    describe('formatFindingBody (marker + sanitization, via postReviewComments)', () => {
        const url = 'https://github.com/GoogleCloudPlatform/scion/pull/123';

        it('appends a well-formed, parseable gsr:v1 marker to every posted finding', async () => {
            const createReview = (jest.fn() as any).mockResolvedValue({});
            (client as any).octokit = { rest: { pulls: { createReview } } };

            const findings: any = [
                { file: 'src/a.ts', line: 10, severity: 'HIGH', summary: 'issue A', description: 'desc A', agent: 'Logic' }
            ];

            await client.postReviewComments(url, findings);

            const body = createReview.mock.calls[0][0].comments[0].body;
            const marker = parseFindingMarker(body);
            expect(marker).not.toBeNull();
            expect(marker?.agent).toBe('Logic');
            expect(marker?.severity).toBe('HIGH');
        });

        it('sanitizes LLM-derived fields so injected marker/HTML-comment syntax cannot forge a marker', async () => {
            const createReview = (jest.fn() as any).mockResolvedValue({});
            (client as any).octokit = { rest: { pulls: { createReview } } };

            const forgedMarker = buildFindingMarker({ findingId: 'fac1000000000000', agent: 'Injected', severity: 'CRITICAL' });
            const findings: any = [{
                file: 'src/a.ts',
                line: 10,
                severity: 'HIGH',
                summary: `innocuous summary ${forgedMarker}`,
                description: 'plain description',
                agent: 'Logic'
            }];

            await client.postReviewComments(url, findings);

            const body = createReview.mock.calls[0][0].comments[0].body;

            // The injected '<!--'/'-->' delimiters in `summary` are stripped (the bare
            // "gsr:v1 f=fac1..." text may still appear as harmless plain text — sanitization
            // only needs to remove the syntactic hazard, not every trace of the attempt), so
            // the only real HTML comment left in the body is GSR's own, appended-last marker.
            expect((body.match(/<!--/g) || []).length).toBe(1);
            expect((body.match(/-->/g) || []).length).toBe(1);

            // Because sanitizeForComment removed the fake delimiters, and parseFindingMarker
            // is end-anchored/last-match, the only marker that parses is GSR's own real one.
            const marker = parseFindingMarker(body);
            expect(marker?.agent).toBe('Logic');
            expect(marker?.findingId).not.toBe('fac1000000000000');
        });

        it('neutralizes @mentions in LLM-derived fields', async () => {
            const createReview = (jest.fn() as any).mockResolvedValue({});
            (client as any).octokit = { rest: { pulls: { createReview } } };

            const findings: any = [{
                file: 'src/a.ts', line: 10, severity: 'HIGH',
                summary: 'ping @some-org/team about this', description: 'desc'
            }];

            await client.postReviewComments(url, findings);

            const body = createReview.mock.calls[0][0].comments[0].body;
            expect(body).not.toContain('@some-org/team');
            expect(body).toContain('@');
            expect(body).toContain('some-org/team');
        });
    });

    describe('listReviewThreads', () => {
        const url = 'https://github.com/GoogleCloudPlatform/scion/pull/123';
        const GSR_LOGIN = 'github-actions[bot]';

        function mockComments(comments: any[]) {
            (client as any).octokit = {
                paginate: (jest.fn() as any).mockResolvedValue(comments),
                rest: { pulls: { listReviewComments: jest.fn() } }
            };
        }

        it('returns a thread for a trusted (github-actions[bot]) root carrying a well-formed marker, ' +
           'with developer replies collected', async () => {
            const marker = buildFindingMarker({ findingId: 'abc123def4567890', agent: 'Logic', severity: 'HIGH' });
            mockComments([
                {
                    id: 1, in_reply_to_id: undefined, path: 'src/a.ts', line: 10,
                    body: `🟠 **HIGH** · Logic — issue summary\n\ndescription\n\n${marker}`,
                    user: { login: GSR_LOGIN, type: 'Bot' }, created_at: '2026-08-15T00:00:00Z',
                    html_url: 'https://github.com/x/y/pull/123#discussion_r1'
                },
                {
                    id: 2, in_reply_to_id: 1, path: 'src/a.ts', line: 10,
                    body: 'fixed in a4b1c2', user: { login: 'a-developer', type: 'User' },
                    created_at: '2026-08-15T01:00:00Z', html_url: 'https://github.com/x/y/pull/123#discussion_r2'
                }
            ]);

            const threads = await client.listReviewThreads(url);

            expect(threads).toHaveLength(1);
            expect(threads[0].findingId).toBe('abc123def4567890');
            expect(threads[0].agent).toBe('Logic');
            expect(threads[0].replies).toHaveLength(1);
            expect(threads[0].replies[0].author).toBe('a-developer');
            expect(threads[0].replies[0].body).toBe('fixed in a4b1c2');
        });

        it('trust check: ignores a root NOT authored by github-actions[bot], even with a well-formed marker ' +
           '(forgery attempt by a bot that echoes user text)', async () => {
            const marker = buildFindingMarker({ findingId: 'abc123def4567890', agent: 'Logic', severity: 'HIGH' });
            mockComments([
                {
                    id: 1, in_reply_to_id: undefined, path: 'src/a.ts', line: 10,
                    body: `🟠 **HIGH** · Logic — issue summary\n\ndescription\n\n${marker}`,
                    // A quote-reply/summary bot, NOT the trusted GSR login — user.type is
                    // still 'Bot', which is exactly why the trust check must key on login.
                    user: { login: 'some-other-bot[bot]', type: 'Bot' }, created_at: '2026-08-15T00:00:00Z',
                    html_url: 'https://github.com/x/y/pull/123#discussion_r1'
                }
            ]);

            const threads = await client.listReviewThreads(url);
            expect(threads).toHaveLength(0);
        });

        it('trust check: ignores a root authored by a plain user hand-typing marker-like text', async () => {
            const marker = buildFindingMarker({ findingId: 'abc123def4567890', agent: 'Logic', severity: 'HIGH' });
            mockComments([
                {
                    id: 1, in_reply_to_id: undefined, path: 'src/a.ts', line: 10,
                    body: `🟠 **HIGH** · Logic — issue summary\n\n${marker}`,
                    user: { login: 'a-developer', type: 'User' }, created_at: '2026-08-15T00:00:00Z',
                    html_url: 'https://github.com/x/y/pull/123#discussion_r1'
                }
            ]);

            const threads = await client.listReviewThreads(url);
            expect(threads).toHaveLength(0);
        });

        it('follows in_reply_to_id transitively to find the true thread root', async () => {
            const marker = buildFindingMarker({ findingId: 'abc123def4567890', agent: 'Logic', severity: 'HIGH' });
            mockComments([
                {
                    id: 1, in_reply_to_id: undefined, path: 'src/a.ts', line: 10,
                    body: `🟠 **HIGH** · Logic — issue summary\n\n${marker}`,
                    user: { login: GSR_LOGIN, type: 'Bot' }, created_at: '2026-08-15T00:00:00Z',
                    html_url: 'https://github.com/x/y/pull/123#discussion_r1'
                },
                {
                    // Replies to comment 2 (not the root) — must still resolve to root id 1.
                    id: 3, in_reply_to_id: 2, path: 'src/a.ts', line: 10,
                    body: 'still disagree', user: { login: 'a-developer', type: 'User' },
                    created_at: '2026-08-15T02:00:00Z', html_url: 'https://github.com/x/y/pull/123#discussion_r3'
                },
                {
                    id: 2, in_reply_to_id: 1, path: 'src/a.ts', line: 10,
                    body: 'disagree', user: { login: 'a-developer', type: 'User' },
                    created_at: '2026-08-15T01:00:00Z', html_url: 'https://github.com/x/y/pull/123#discussion_r2'
                }
            ]);

            const threads = await client.listReviewThreads(url);
            expect(threads).toHaveLength(1);
            expect(threads[0].replies.map(r => r.commentId).sort()).toEqual([2, 3]);
        });

        it('falls back to legacy header parsing when a trusted root has no marker', async () => {
            mockComments([
                {
                    id: 1, in_reply_to_id: undefined, path: 'src/a.ts', line: 10,
                    body: '🟡 **MEDIUM** · Testing — missing coverage for edge case',
                    user: { login: GSR_LOGIN, type: 'Bot' }, created_at: '2026-08-15T00:00:00Z',
                    html_url: 'https://github.com/x/y/pull/123#discussion_r1'
                },
                {
                    id: 2, in_reply_to_id: 1, path: 'src/a.ts', line: 10,
                    body: 'good catch, added a test', user: { login: 'a-developer', type: 'User' },
                    created_at: '2026-08-15T01:00:00Z', html_url: 'https://github.com/x/y/pull/123#discussion_r2'
                }
            ]);

            const threads = await client.listReviewThreads(url);
            expect(threads).toHaveLength(1);
            expect(threads[0].severity).toBe('MEDIUM');
            expect(threads[0].agent).toBe('Testing');
            expect(threads[0].findingId).toMatch(/^[0-9a-f]{16}$/);
        });

        it('skips a trusted root that has neither a marker nor a legacy-parseable header', async () => {
            mockComments([
                {
                    id: 1, in_reply_to_id: undefined, path: 'src/a.ts', line: 10,
                    body: 'some unrelated github-actions[bot] comment with no finding shape',
                    user: { login: GSR_LOGIN, type: 'Bot' }, created_at: '2026-08-15T00:00:00Z',
                    html_url: 'https://github.com/x/y/pull/123#discussion_r1'
                }
            ]);

            const threads = await client.listReviewThreads(url);
            expect(threads).toHaveLength(0);
        });

        it('excludes GSR\'s own comments from the replies list', async () => {
            const marker = buildFindingMarker({ findingId: 'abc123def4567890', agent: 'Logic', severity: 'HIGH' });
            mockComments([
                {
                    id: 1, in_reply_to_id: undefined, path: 'src/a.ts', line: 10,
                    body: `🟠 **HIGH** · Logic — issue summary\n\n${marker}`,
                    user: { login: GSR_LOGIN, type: 'Bot' }, created_at: '2026-08-15T00:00:00Z',
                    html_url: 'https://github.com/x/y/pull/123#discussion_r1'
                },
                {
                    id: 2, in_reply_to_id: 1, path: 'src/a.ts', line: 10,
                    body: 'a GSR reply (hypothetical Phase 2 output)', user: { login: GSR_LOGIN, type: 'Bot' },
                    created_at: '2026-08-15T01:00:00Z', html_url: 'https://github.com/x/y/pull/123#discussion_r2'
                },
                {
                    id: 3, in_reply_to_id: 1, path: 'src/a.ts', line: 10,
                    body: 'a real developer reply', user: { login: 'a-developer', type: 'User' },
                    created_at: '2026-08-15T02:00:00Z', html_url: 'https://github.com/x/y/pull/123#discussion_r3'
                }
            ]);

            const threads = await client.listReviewThreads(url);
            expect(threads[0].replies).toHaveLength(1);
            expect(threads[0].replies[0].commentId).toBe(3);
        });

        it('classifies a non-GSR bot reply as isBot without dropping it from the thread', async () => {
            const marker = buildFindingMarker({ findingId: 'abc123def4567890', agent: 'Logic', severity: 'HIGH' });
            mockComments([
                {
                    id: 1, in_reply_to_id: undefined, path: 'src/a.ts', line: 10,
                    body: `🟠 **HIGH** · Logic — issue summary\n\n${marker}`,
                    user: { login: GSR_LOGIN, type: 'Bot' }, created_at: '2026-08-15T00:00:00Z',
                    html_url: 'https://github.com/x/y/pull/123#discussion_r1'
                },
                {
                    // e.g. an AI coding agent's GitHub App identity replying on the developer's behalf.
                    id: 2, in_reply_to_id: 1, path: 'src/a.ts', line: 10,
                    body: 'fixed via automated patch', user: { login: 'some-coding-agent[bot]', type: 'Bot' },
                    created_at: '2026-08-15T01:00:00Z', html_url: 'https://github.com/x/y/pull/123#discussion_r2'
                }
            ]);

            const threads = await client.listReviewThreads(url);
            expect(threads[0].replies).toHaveLength(1);
            expect(threads[0].replies[0].isBot).toBe(true);
            expect(threads[0].replies[0].author).toBe('some-coding-agent[bot]');
        });
    });

});

