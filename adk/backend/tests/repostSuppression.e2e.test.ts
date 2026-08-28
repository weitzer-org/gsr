// Multi-push simulation (review-quality-design.md §7.2), targeting Gap 1
// specifically: run GSR's review-and-post logic more than once against the
// same PR and assert that a finding whose flagged file hasn't changed never
// gets a second full inline comment — this is the PR #17 WriteHeader
// regression this whole feature exists to fix, reproduced end-to-end
// through the REAL GitHubClient.postReviewComments /
// GitHubClient.listReviewThreads / repostSuppression.planRepost, not a
// hand-built fixture. Same style as feedbackLoop.e2e.test.ts: only Octokit's
// HTTP layer is mocked; every marker build/parse and repost decision is the
// real implementation.

import { jest, describe, it, expect } from '@jest/globals';
import { GitHubClient } from '../src/github';
import { planRepost } from '../src/repostSuppression';
import { parseFindingMarker, computeFindingId } from '../src/findingMarker';
import { CandidateFinding, DiffChunk } from '../src/types';

const PR_URL = 'https://github.com/weitzer-org/gsr/pull/17';
const GSR_LOGIN = 'github-actions[bot]';

// A minimal fixture that behaves like a real Octokit instance across
// several simulated Action runs: `postedComments` accumulates every inline
// comment createReview has ever been asked to post (across all runs, in
// order), and listReviewComments/paginate serves those back as the current
// PR state, mirroring what a real re-review would observe.
function makeFakeOctokit() {
  const postedComments: { id: number; path: string; line: number; body: string }[] = [];
  const createReviewCalls: { body: string; comments?: any[] }[] = [];
  let nextCommentId = 1000;

  const octokit = {
    rest: {
      pulls: {
        createReview: (jest.fn() as any).mockImplementation((args: any) => {
          createReviewCalls.push({ body: args.body, comments: args.comments });
          for (const c of args.comments || []) {
            postedComments.push({ id: nextCommentId++, path: c.path, line: c.line, body: c.body });
          }
          return Promise.resolve({ data: {} });
        }),
        createReviewComment: jest.fn(),
        createReplyForReviewComment: jest.fn(),
        get: (jest.fn() as any).mockResolvedValue({ data: { head: { sha: 'abc123' } } }),
        listReviewComments: jest.fn(),
      },
      issues: { createComment: jest.fn() },
    },
    paginate: (jest.fn() as any).mockImplementation(() =>
      Promise.resolve(
        postedComments.map(c => ({
          id: c.id,
          in_reply_to_id: undefined,
          user: { login: GSR_LOGIN, type: 'Bot' },
          body: c.body,
          html_url: `${PR_URL}#discussion_r${c.id}`,
          path: c.path,
          line: c.line,
          original_line: c.line,
        })),
      ),
    ),
  };

  return { octokit, createReviewCalls, postedComments };
}

const writeHeaderFinding: CandidateFinding = {
  file: 'server/handler.go',
  line: 42,
  severity: 'HIGH',
  summary: 'WriteHeader in Write bypasses Content-Type sniffing',
  description: 'Calling w.WriteHeader before w.Write skips automatic Content-Type detection.',
  agent: 'Logic',
  promptVersion: 'system_prompts',
};

const otherFinding: CandidateFinding = {
  file: 'server/other.go',
  line: 10,
  severity: 'MEDIUM',
  summary: 'unrelated finding in a different file',
  description: 'description',
  agent: 'TechDebt',
  promptVersion: 'system_prompts',
};

describe('Multi-push simulation (§7.2) — repost-suppression end to end', () => {
  it('does not repost an unchanged finding across 3 consecutive unchanged-diff runs (the PR #17 WriteHeader case)', async () => {
    const { octokit, createReviewCalls } = makeFakeOctokit();
    const client = new GitHubClient('mock-pat');
    (client as any).octokit = octokit;

    const diffV1: DiffChunk[] = [{ file: 'server/handler.go', content: '@@ -40,3 +40,3 @@\n-old\n+new' }];

    // --- Run 1: nothing posted yet — finding is new. ---
    const findingWithId1: CandidateFinding = { ...writeHeaderFinding, id: computeFindingIdFor(writeHeaderFinding) };
    const priorThreads1 = await client.listReviewThreads(PR_URL);
    expect(priorThreads1).toHaveLength(0);

    const plan1 = planRepost([findingWithId1], priorThreads1, diffV1);
    expect(plan1.toPost).toHaveLength(1);
    const post1 = await client.postReviewComments(PR_URL, plan1.toPost, {
      summaryTotalCount: 1,
      collapsedCount: plan1.collapsedCount,
      markerOverrides: plan1.markerOverrides,
    });
    expect(post1).toEqual({ posted: 1, skipped: 0 });
    expect(createReviewCalls).toHaveLength(1);

    // --- Runs 2 and 3: the author pushes commits touching OTHER files;
    // server/handler.go's diff content is byte-identical both times. Each
    // run re-discovers the exact same finding (same file/line/agent — same
    // findingId) via the orchestrator. Neither run should produce a new
    // inline comment. ---
    for (let run = 2; run <= 3; run++) {
      const findingThisRun: CandidateFinding = { ...writeHeaderFinding, id: computeFindingIdFor(writeHeaderFinding) };
      const priorThreads = await client.listReviewThreads(PR_URL);
      expect(priorThreads).toHaveLength(1); // still exactly the one comment from run 1

      const plan = planRepost([findingThisRun], priorThreads, diffV1); // same diff content as run 1
      expect(plan.toPost).toHaveLength(0);
      expect(plan.collapsedCount).toBe(0);

      const postResult = await client.postReviewComments(PR_URL, plan.toPost, {
        summaryTotalCount: 1,
        collapsedCount: plan.collapsedCount,
        markerOverrides: plan.markerOverrides,
      });
      expect(postResult).toEqual({ posted: 0, skipped: 0 });
    }

    // Across all 3 runs, exactly ONE createReview call ever carried an
    // inline comment for this finding — runs 2 and 3's calls posted a
    // summary-only review (still says "1 finding(s)." per §9 open question
    // 1's "N stays accurate" resolution) with zero attached comments.
    expect(createReviewCalls).toHaveLength(3);
    expect(createReviewCalls[0].comments).toHaveLength(1);
    expect(createReviewCalls[1].comments ?? []).toHaveLength(0);
    expect(createReviewCalls[2].comments ?? []).toHaveLength(0);
    expect(createReviewCalls[1].body).toContain('1 finding(s).');
    expect(createReviewCalls[1].body).not.toContain('no issues found');
  });

  it('reposts (capped) when the flagged file\'s diff content actually changes, and collapses after REPOST_THRESHOLD', async () => {
    const { octokit, createReviewCalls } = makeFakeOctokit();
    const client = new GitHubClient('mock-pat');
    (client as any).octokit = octokit;

    // Each "run" edits server/handler.go again (content hash changes every
    // time), so the finding keeps legitimately re-appearing — simulating an
    // author who keeps tweaking the line without fixing the root cause.
    for (let run = 1; run <= 4; run++) {
      const diff: DiffChunk[] = [{ file: 'server/handler.go', content: `@@ -40,3 +40,3 @@\n-old\n+new-v${run}` }];
      const findingThisRun: CandidateFinding = { ...writeHeaderFinding, id: computeFindingIdFor(writeHeaderFinding) };
      const priorThreads = await client.listReviewThreads(PR_URL);

      const plan = planRepost([findingThisRun], priorThreads, diff);
      await client.postReviewComments(PR_URL, plan.toPost, {
        summaryTotalCount: 1,
        collapsedCount: plan.collapsedCount,
        markerOverrides: plan.markerOverrides,
      });
    }

    // Runs 1-3 post a full comment (repostCount reaching 1, 2, 3); run 4
    // (would-be repostCount 4) collapses instead of posting a 4th full body.
    const commentCounts = createReviewCalls.map(c => (c.comments ?? []).length);
    expect(commentCounts).toEqual([1, 1, 1, 0]);
    expect(createReviewCalls[3].body).toContain('finding(s) raised in prior reviews remain unaddressed');

    // The 3rd posted comment's marker really does carry n=3 — confirms the
    // counter round-trips through the real marker, not just the in-memory plan.
    const thirdPostedBody = createReviewCalls[2].comments![0].body;
    expect(parseFindingMarker(thirdPostedBody)?.repostCount).toBe(3);
  });

  it('a finding on a different file is unaffected by another file\'s suppression state', async () => {
    const { octokit, createReviewCalls } = makeFakeOctokit();
    const client = new GitHubClient('mock-pat');
    (client as any).octokit = octokit;

    const diff: DiffChunk[] = [
      { file: 'server/handler.go', content: '@@ -40,3 +40,3 @@\n-old\n+new' },
      { file: 'server/other.go', content: '@@ -8,3 +8,3 @@\n-a\n+b' },
    ];
    const findings: CandidateFinding[] = [
      { ...writeHeaderFinding, id: computeFindingIdFor(writeHeaderFinding) },
      { ...otherFinding, id: computeFindingIdFor(otherFinding) },
    ];

    // Run 1: both new.
    let priorThreads = await client.listReviewThreads(PR_URL);
    let plan = planRepost(findings, priorThreads, diff);
    await client.postReviewComments(PR_URL, plan.toPost, {
      summaryTotalCount: 2, collapsedCount: plan.collapsedCount, markerOverrides: plan.markerOverrides,
    });
    expect(createReviewCalls[0].comments).toHaveLength(2);

    // Run 2: server/other.go changes; server/handler.go does not.
    const diffRun2: DiffChunk[] = [
      { file: 'server/handler.go', content: '@@ -40,3 +40,3 @@\n-old\n+new' }, // identical
      { file: 'server/other.go', content: '@@ -8,3 +8,3 @@\n-a\n+different' }, // changed
    ];
    priorThreads = await client.listReviewThreads(PR_URL);
    expect(priorThreads).toHaveLength(2);
    plan = planRepost(findings, priorThreads, diffRun2);
    // handler.go's finding suppressed; other.go's finding reposts (content changed, under threshold).
    expect(plan.toPost.map(f => f.file)).toEqual(['server/other.go']);
  });
});

// Mirrors what orchestrator.ts does for every finding before it reaches
// action-entrypoint.ts (orchestrator.ts:273's `id: f.id || computeFindingId(f)`)
// — this test simulates the orchestrator's output, not the orchestrator itself.
function computeFindingIdFor(finding: CandidateFinding): string {
  return computeFindingId(finding);
}
