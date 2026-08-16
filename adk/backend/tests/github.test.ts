import { GitHubClient } from '../src/github';
import { buildFindingMarker, buildReplyMarker, parseFindingMarker, computeFindingId } from '../src/findingMarker';
import { jest } from '@jest/globals';


describe('GitHubClient', () => {
    let client: GitHubClient;

    beforeEach(() => {
        client = new GitHubClient('mock-pat');
    });

    // Self-review finding: a test further down restored its console.warn
    // spy manually at the end of the `it` block — if an assertion earlier
    // in that test throws, the manual restore never runs, leaking the
    // suppressed console.warn into every test that runs after it. A file-
    // level afterEach makes cleanup unconditional regardless of how a test
    // exits.
    afterEach(() => {
        jest.restoreAllMocks();
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

        it('includes a trusted GSR finding that has zero replies yet, instead of silently dropping it ' +
           '(self-review finding: only replies used to create a grouped-map entry, so an as-yet-unanswered ' +
           'finding never appeared in listReviewThreads\' output at all)', async () => {
            const marker = buildFindingMarker({ findingId: 'ab00000000000001', agent: 'Logic', severity: 'HIGH' });
            mockComments([
                {
                    id: 1, in_reply_to_id: undefined, path: 'src/a.ts', line: 10,
                    body: `🟠 **HIGH** · Logic — issue summary\n\n${marker}`,
                    user: { login: GSR_LOGIN, type: 'Bot' }, created_at: '2026-08-15T00:00:00Z',
                    html_url: 'https://github.com/x/y/pull/123#discussion_r1'
                }
                // No reply — nobody has responded to this finding yet.
            ]);

            const threads = await client.listReviewThreads(url);
            expect(threads).toHaveLength(1);
            expect(threads[0].findingId).toBe('ab00000000000001');
            expect(threads[0].replies).toEqual([]);
        });

        it('computes the legacy findingId from original_line, not the current (possibly force-push-shifted) line ' +
           '(self-review finding: using `line` let a legacy finding\'s identity silently change across runs)', async () => {
            mockComments([
                {
                    id: 1, in_reply_to_id: undefined, path: 'src/a.ts',
                    line: 99, original_line: 10, // current line has drifted from where the comment was created
                    body: '🟡 **MEDIUM** · Testing — missing coverage for edge case',
                    user: { login: GSR_LOGIN, type: 'Bot' }, created_at: '2026-08-15T00:00:00Z',
                    html_url: 'https://github.com/x/y/pull/123#discussion_r1'
                },
                {
                    id: 2, in_reply_to_id: 1, path: 'src/a.ts', line: 99,
                    body: 'fixed', user: { login: 'a-developer', type: 'User' },
                    created_at: '2026-08-15T01:00:00Z', html_url: 'https://github.com/x/y/pull/123#discussion_r2'
                }
            ]);

            const threads = await client.listReviewThreads(url);
            expect(threads[0].findingId).toBe(computeFindingId({
                file: 'src/a.ts', line: 10, agent: 'Testing', summary: 'missing coverage for edge case',
            }));
        });

        it('stops requesting further pages once the 500-comment cap is reached, ' +
           'instead of paginating the whole PR first and truncating after (security-review finding)', async () => {
            // Simulates octokit.paginate's real per-page mapFn/done() contract —
            // the earlier bug was that the mock in other tests here bypasses this
            // entirely (mockResolvedValue short-circuits straight to a final
            // array), which is exactly why this specific behavior had no coverage.
            let pagesRequested = 0;
            const paginate = jest.fn(async (_route: any, _params: any, mapFn: any) => {
                const acc: any[] = [];
                for (let page = 0; page < 10; page++) {
                    pagesRequested++;
                    const data = Array.from({ length: 100 }, (_, i) => ({
                        id: page * 100 + i + 1,
                        in_reply_to_id: undefined,
                        user: { login: 'a-random-user', type: 'User' },
                        body: 'not a GSR finding',
                        html_url: 'https://github.com/x/y/pull/123',
                    }));
                    let stopped = false;
                    const mapped = mapFn({ data }, () => { stopped = true; });
                    acc.push(...mapped);
                    if (stopped) break;
                }
                return acc;
            });
            (client as any).octokit = { paginate, rest: { pulls: { listReviewComments: jest.fn() } } };

            await client.listReviewThreads(url);

            // 500 / 100-per-page = 5 pages needed; must not have walked all 10.
            expect(pagesRequested).toBe(5);
        });

        it('still warns about truncation when the actual comment count lands on an exact multiple of per_page ' +
           '(self-review finding: comments.length > cap is false at exactly 500, even when a 6th page of real ' +
           'comments existed and was never fetched — inferring "was truncated" from a length comparison missed ' +
           'exactly the boundary case it exists to catch)', async () => {
            // 6 pages of 100 exist in total, but the cap stops fetching after
            // page 5 (500 comments) — comments.length ends up EXACTLY 500,
            // so the old `comments.length > 500` check would never fire here.
            const paginate = jest.fn(async (_route: any, _params: any, mapFn: any) => {
                const acc: any[] = [];
                for (let page = 0; page < 6; page++) {
                    const data = Array.from({ length: 100 }, (_, i) => ({
                        id: page * 100 + i + 1,
                        in_reply_to_id: undefined,
                        user: { login: 'a-random-user', type: 'User' },
                        body: 'not a GSR finding',
                        html_url: 'https://github.com/x/y/pull/123',
                    }));
                    let stopped = false;
                    const mapped = mapFn({ data }, () => { stopped = true; });
                    acc.push(...mapped);
                    if (stopped) break;
                }
                return acc;
            });
            (client as any).octokit = { paginate, rest: { pulls: { listReviewComments: jest.fn() } } };
            const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

            await client.listReviewThreads(url);

            expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('capping feedback-loop scan'));
            // Restored unconditionally by the file-level afterEach above,
            // regardless of whether the assertion on the previous line passes.
        });

        describe('path/line/rootBody (Phase 2: adjudication context)', () => {
            it('surfaces the root comment\'s path, original_line, and raw body on the thread', async () => {
                const marker = buildFindingMarker({ findingId: 'abc123def4567890', agent: 'Logic', severity: 'HIGH' });
                const rootBody = `🟠 **HIGH** · Logic — issue summary\n\ndescription text\n\n${marker}`;
                mockComments([
                    {
                        id: 1, in_reply_to_id: undefined, path: 'src/a.ts', line: 12, original_line: 10,
                        body: rootBody, user: { login: GSR_LOGIN, type: 'Bot' }, created_at: '2026-08-15T00:00:00Z',
                        html_url: 'https://github.com/x/y/pull/123#discussion_r1'
                    }
                ]);

                const threads = await client.listReviewThreads(url);
                expect(threads[0].path).toBe('src/a.ts');
                expect(threads[0].line).toBe(10); // original_line preferred over the current (possibly shifted) line
                expect(threads[0].rootBody).toBe(rootBody);
            });

            it('falls back to `line` when original_line is absent', async () => {
                const marker = buildFindingMarker({ findingId: 'abc123def4567890', agent: 'Logic', severity: 'HIGH' });
                mockComments([
                    {
                        id: 1, in_reply_to_id: undefined, path: 'src/a.ts', line: 12,
                        body: `🟠 **HIGH** · Logic — issue summary\n\n${marker}`,
                        user: { login: GSR_LOGIN, type: 'Bot' }, created_at: '2026-08-15T00:00:00Z',
                        html_url: 'https://github.com/x/y/pull/123#discussion_r1'
                    }
                ]);

                const threads = await client.listReviewThreads(url);
                expect(threads[0].line).toBe(12);
            });
        });

        describe('gsrLastReply derivation (Phase 2: round/ack state, no persistence)', () => {
            it('derives round/ack/verdict/confidence from a well-formed gsr-reply:v1 marker on a trusted reply', async () => {
                const findingMarker = buildFindingMarker({ findingId: 'abc123def4567890', agent: 'Logic', severity: 'HIGH' });
                const replyMarker = buildReplyMarker({
                    findingId: 'abc123def4567890', round: 1, verdict: 'pushback_incorrect', confidence: 0.82, ackCommentId: 2,
                });
                mockComments([
                    {
                        id: 1, in_reply_to_id: undefined, path: 'src/a.ts', line: 10,
                        body: `🟠 **HIGH** · Logic — issue summary\n\n${findingMarker}`,
                        user: { login: GSR_LOGIN, type: 'Bot' }, created_at: '2026-08-15T00:00:00Z',
                        html_url: 'https://github.com/x/y/pull/123#discussion_r1'
                    },
                    {
                        id: 2, in_reply_to_id: 1, path: 'src/a.ts', line: 10,
                        body: 'disagree, false positive', user: { login: 'a-developer', type: 'User' },
                        created_at: '2026-08-15T01:00:00Z', html_url: 'https://github.com/x/y/pull/123#discussion_r2'
                    },
                    {
                        id: 3, in_reply_to_id: 1, path: 'src/a.ts', line: 10,
                        body: `Here is why it still stands.\n\n${replyMarker}`,
                        user: { login: GSR_LOGIN, type: 'Bot' }, created_at: '2026-08-15T02:00:00Z',
                        html_url: 'https://github.com/x/y/pull/123#discussion_r3'
                    }
                ]);

                const threads = await client.listReviewThreads(url);
                expect(threads[0].gsrLastReply).toEqual({
                    round: 1, ackCommentId: 2, verdict: 'pushback_incorrect', confidence: 0.82,
                });
                // GSR's own reply must not show up in the developer-facing replies list.
                expect(threads[0].replies.map(r => r.commentId)).toEqual([2]);
            });

            it('is undefined when GSR has never replied in this thread', async () => {
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
                        body: 'disagree', user: { login: 'a-developer', type: 'User' },
                        created_at: '2026-08-15T01:00:00Z', html_url: 'https://github.com/x/y/pull/123#discussion_r2'
                    }
                ]);

                const threads = await client.listReviewThreads(url);
                expect(threads[0].gsrLastReply).toBeUndefined();
            });

            it('FAILS CLOSED: a trusted-login reply with malformed gsr-reply:v1 syntax still counts as "GSR has ' +
               'replied" (round pinned at Number.MAX_SAFE_INTEGER), never as round 0 — a parser bug must suppress ' +
               'a further rebuttal, never silently permit a second one', async () => {
                const marker = buildFindingMarker({ findingId: 'abc123def4567890', agent: 'Logic', severity: 'HIGH' });
                mockComments([
                    {
                        id: 1, in_reply_to_id: undefined, path: 'src/a.ts', line: 10,
                        body: `🟠 **HIGH** · Logic — issue summary\n\n${marker}`,
                        user: { login: GSR_LOGIN, type: 'Bot' }, created_at: '2026-08-15T00:00:00Z',
                        html_url: 'https://github.com/x/y/pull/123#discussion_r1'
                    },
                    {
                        // Malformed marker: round=0 is invalid, so parseReplyMarker returns null.
                        id: 2, in_reply_to_id: 1, path: 'src/a.ts', line: 10,
                        body: '<!-- gsr-reply:v1 f=abc123def4567890 round=0 verdict=unclear conf=0.5 ack=1 -->',
                        user: { login: GSR_LOGIN, type: 'Bot' }, created_at: '2026-08-15T01:00:00Z',
                        html_url: 'https://github.com/x/y/pull/123#discussion_r2'
                    }
                ]);

                const threads = await client.listReviewThreads(url);
                expect(threads[0].gsrLastReply?.round).toBe(Number.MAX_SAFE_INTEGER);
                expect(threads[0].gsrLastReply?.ackCommentId).toBe(2); // falls back to the comment's own id
            });

            it('FAILS CLOSED: a trusted-login reply with NO marker syntax at all still counts as "GSR has replied"', async () => {
                const marker = buildFindingMarker({ findingId: 'abc123def4567890', agent: 'Logic', severity: 'HIGH' });
                mockComments([
                    {
                        id: 1, in_reply_to_id: undefined, path: 'src/a.ts', line: 10,
                        body: `🟠 **HIGH** · Logic — issue summary\n\n${marker}`,
                        user: { login: GSR_LOGIN, type: 'Bot' }, created_at: '2026-08-15T00:00:00Z',
                        html_url: 'https://github.com/x/y/pull/123#discussion_r1'
                    },
                    {
                        // A trusted-login reply that forgot to append a marker at all (bug, or future code path).
                        id: 2, in_reply_to_id: 1, path: 'src/a.ts', line: 10,
                        body: 'a GSR reply with no marker somehow',
                        user: { login: GSR_LOGIN, type: 'Bot' }, created_at: '2026-08-15T01:00:00Z',
                        html_url: 'https://github.com/x/y/pull/123#discussion_r2'
                    }
                ]);

                const threads = await client.listReviewThreads(url);
                expect(threads[0].gsrLastReply?.round).toBe(Number.MAX_SAFE_INTEGER);
            });

            it('takes independent maximums of round and ack across multiple trusted replies (race-condition safety)', async () => {
                const findingMarker = buildFindingMarker({ findingId: 'abc123def4567890', agent: 'Logic', severity: 'HIGH' });
                // Two GSR replies from a hypothetical concurrent-run race: one has
                // a higher round but a LOWER ack than the other — the derivation
                // must not simply pick "whichever comment has the highest round"
                // and inherit its (lower) ack, which would un-suppress replies the
                // other run already accounted for.
                const replyA = buildReplyMarker({ findingId: 'abc123def4567890', round: 2, verdict: 'unclear', confidence: 0.4, ackCommentId: 10 });
                const replyB = buildReplyMarker({ findingId: 'abc123def4567890', round: 1, verdict: 'pushback_incorrect', confidence: 0.9, ackCommentId: 50 });
                mockComments([
                    {
                        id: 1, in_reply_to_id: undefined, path: 'src/a.ts', line: 10,
                        body: `🟠 **HIGH** · Logic — issue summary\n\n${findingMarker}`,
                        user: { login: GSR_LOGIN, type: 'Bot' }, created_at: '2026-08-15T00:00:00Z',
                        html_url: 'https://github.com/x/y/pull/123#discussion_r1'
                    },
                    {
                        id: 2, in_reply_to_id: 1, path: 'src/a.ts', line: 10, body: `text\n\n${replyA}`,
                        user: { login: GSR_LOGIN, type: 'Bot' }, created_at: '2026-08-15T01:00:00Z',
                        html_url: 'https://github.com/x/y/pull/123#discussion_r2'
                    },
                    {
                        id: 3, in_reply_to_id: 1, path: 'src/a.ts', line: 10, body: `text\n\n${replyB}`,
                        user: { login: GSR_LOGIN, type: 'Bot' }, created_at: '2026-08-15T02:00:00Z',
                        html_url: 'https://github.com/x/y/pull/123#discussion_r3'
                    }
                ]);

                const threads = await client.listReviewThreads(url);
                expect(threads[0].gsrLastReply?.round).toBe(2); // max round
                expect(threads[0].gsrLastReply?.ackCommentId).toBe(50); // max ack, independently
            });
        });
    });

    describe('createThreadReply', () => {
        const url = 'https://github.com/GoogleCloudPlatform/scion/pull/123';

        it('posts a reply into the thread rooted at rootCommentId and returns { posted: true, htmlUrl }', async () => {
            const createReplyForReviewComment = (jest.fn() as any).mockResolvedValue({
                data: { html_url: `${url}#discussion_r99` },
            });
            (client as any).octokit = { rest: { pulls: { createReplyForReviewComment } } };

            const result = await client.createThreadReply(url, 42, 'a rebuttal');

            expect(result).toEqual({ posted: true, htmlUrl: `${url}#discussion_r99` });
            expect(createReplyForReviewComment).toHaveBeenCalledWith(expect.objectContaining({
                comment_id: 42, body: 'a rebuttal',
            }));
        });

        it('never throws: a 403 (read-only GITHUB_TOKEN, e.g. a fork PR, or a rate limit) resolves to a "fork-read-only" outcome', async () => {
            const error: any = new Error('Forbidden');
            error.status = 403;
            const createReplyForReviewComment = (jest.fn() as any).mockRejectedValue(error);
            (client as any).octokit = { rest: { pulls: { createReplyForReviewComment } } };

            const result = await client.createThreadReply(url, 42, 'a rebuttal');

            expect(result).toEqual({ posted: false, reason: 'fork-read-only', message: 'Forbidden' });
        });

        it('never throws: any other error resolves to a generic "error" outcome', async () => {
            const createReplyForReviewComment = (jest.fn() as any).mockRejectedValue(new Error('thread was deleted'));
            (client as any).octokit = { rest: { pulls: { createReplyForReviewComment } } };

            const result = await client.createThreadReply(url, 42, 'a rebuttal');

            expect(result).toEqual({ posted: false, reason: 'error', message: 'thread was deleted' });
        });

        it('never throws: a malformed URL resolves to a generic "error" outcome instead of rejecting ' +
           '(PR #61 self-review finding: parsePRUrl used to be called BEFORE the try block, so this threw ' +
           'synchronously despite the docstring promising "never throws")', async () => {
            (client as any).octokit = { rest: { pulls: { createReplyForReviewComment: jest.fn() } } };

            const result = await client.createThreadReply('not-a-valid-pr-url', 42, 'a rebuttal');

            expect(result).toEqual({ posted: false, reason: 'error', message: 'Invalid GitHub Pull Request URL.' });
        });
    });

});

