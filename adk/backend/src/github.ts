import { Octokit } from '@octokit/rest';
import { CandidateFinding, DiffChunk, FindingThread, ThreadReply, AdjudicationVerdict } from './types.js';
import {
  buildFindingMarker,
  computeFindingId,
  parseFindingMarker,
  parseLegacyFindingBody,
  parseReplyMarker,
  sanitizeForComment,
} from './findingMarker.js';

const SEVERITY_EMOJI: Record<string, string> = {
  CRITICAL: '🔴',
  HIGH: '🟠',
  MEDIUM: '🟡',
  LOW: '🔵'
};

// The login GitHub's own Actions runner uses for GITHUB_TOKEN-authored API
// calls. This is what makes a comment "GSR's own" for the feedback loop's
// trust check (pr-comment-feedback-loop-design.md §9, T2) — deliberately
// `user.login === TRUSTED_GSR_BOT_LOGIN`, NOT `user.type === 'Bot'`. The
// broader `type === 'Bot'` check would also match any other bot that echoes
// user-supplied text back (a quote-reply bot, a PR-summary bot), which would
// let that bot's comments forge a trusted `gsr:v1` marker.
//
// Caveat: on GitHub Enterprise Server / some self-hosted-runner
// configurations this login string may reportedly differ. That has not been
// verified against a GHES instance in this repo — treat it as a known gap,
// not a silently-assumed universal constant, if GSR is ever run there.
const TRUSTED_GSR_BOT_LOGIN = 'github-actions[bot]';

export class GitHubClient {
  private octokit: Octokit;

  constructor(pat: string) {
    this.octokit = new Octokit({ auth: pat });
  }

  /**
   * Parses a GitHub PR URL to extract owner, repo, and pull_number
   */
  public parsePRUrl(url: string): { owner: string, repo: string, pull_number: number } {
    const regex = /github\.com\/([^\/]+)\/([^\/]+)\/pull\/(\d+)/;
    const match = url.match(regex);
    if (!match) {
      throw new Error("Invalid GitHub Pull Request URL.");
    }
    return {
      owner: match[1],
      repo: match[2],
      pull_number: parseInt(match[3], 10)
    };
  }

  /**
   * Fetches the file changes of a Pull Request and maps them into chunks
   */
  public async getPRDiff(url: string): Promise<DiffChunk[]> {
    const { owner, repo, pull_number } = this.parsePRUrl(url);

    try {
      // Use pagination to fetch all files without hitting the 300 file monolithic limit
      const files = await this.octokit.paginate(this.octokit.rest.pulls.listFiles, {
        owner,
        repo,
        pull_number,
        per_page: 100
      });

      const IGNORE_PATTERNS = [
        /package-lock\.json$/i,
        /yarn\.lock$/i,
        /pnpm-lock\.yaml$/i,
        /\.min\.js$/i,
        /\.bundle\.js$/i,
        /\.svg$/i,
        /^dist\//i,
        /^build\//i
      ];

      const chunks: DiffChunk[] = [];
      for (const file of files) {
        // file.patch only exists if the file was modified and the diff is not too large
        if (file.patch) {
          const isIgnored = IGNORE_PATTERNS.some(pattern => pattern.test(file.filename));
          if (!isIgnored) {
            chunks.push({
              file: file.filename,
              content: file.patch
            });
          }
        }
      }
      return chunks;
    } catch (error: any) {
      console.error("Failed to fetch PR diff:", error);
      throw new Error(`Failed to fetch PR diff: ${error.message}`);
    }
  }

  // Sanitizes every LLM/diff-derived field before it goes into a posted
  // comment body (pr-comment-feedback-loop-design.md §9, T2) and appends the
  // feedback loop's invisible marker. `summary`/`description`/`suggestion`
  // are Gemini output shaped by attacker-controlled diff content; `agent`
  // is normally orchestrator-assigned but can be LLM-merged text after the
  // deduplicator runs ("Performance, Security" — deduplicator.ts), so it's
  // sanitized too as defense in depth even though the marker's own `a=`
  // field is separately safe via percent-encoding. `severity` is left alone
  // — it's schema-constrained to one of four enum values and used as a
  // lookup key, not free text.
  private formatFindingBody(finding: CandidateFinding): string {
    const emoji = SEVERITY_EMOJI[finding.severity] || '';
    const summary = sanitizeForComment(finding.summary);
    const description = sanitizeForComment(finding.description);
    const agent = finding.agent ? sanitizeForComment(finding.agent) : finding.agent;

    let body = `${emoji} **${finding.severity}**${agent ? ` · ${agent}` : ''} — ${summary}\n\n${description}`;
    if (finding.suggestion) {
      body += `\n\n${sanitizeForComment(finding.suggestion)}`;
    }

    const findingId = finding.id || computeFindingId(finding);
    const marker = buildFindingMarker({
      findingId,
      agent: finding.agent,
      severity: finding.severity,
      promptVersion: finding.promptVersion,
    });
    body += `\n\n${marker}`;

    return body;
  }

  /**
   * Submits findings as a single GitHub PR review with inline comments. The
   * Reviews API rejects the whole batch if any comment's line isn't part of
   * the diff, so on failure we fall back to posting comments one at a time
   * (skipping only the ones GitHub rejects) plus a summary issue comment.
   */
  public async postReviewComments(url: string, findings: CandidateFinding[]): Promise<{ posted: number; skipped: number }> {
    const { owner, repo, pull_number } = this.parsePRUrl(url);
    const summary = findings.length === 0
      ? '**GSR Review** — no issues found.'
      : `**GSR Review** — ${findings.length} finding(s).`;

    if (findings.length === 0) {
      await this.octokit.rest.pulls.createReview({ owner, repo, pull_number, event: 'COMMENT', body: summary });
      return { posted: 0, skipped: 0 };
    }

    const comments = findings.map(f => ({
      path: f.file,
      line: f.line,
      side: 'RIGHT' as const,
      body: this.formatFindingBody(f)
    }));

    try {
      await this.octokit.rest.pulls.createReview({ owner, repo, pull_number, event: 'COMMENT', body: summary, comments });
      return { posted: comments.length, skipped: 0 };
    } catch (error: any) {
      console.warn(`Batched review submission failed (${error.message}); falling back to posting comments individually.`);

      const pr = await this.octokit.rest.pulls.get({ owner, repo, pull_number });
      const commit_id = pr.data.head.sha;

      let posted = 0;
      let skipped = 0;
      const skippedComments: string[] = [];
      for (const comment of comments) {
        try {
          await this.octokit.rest.pulls.createReviewComment({
            owner, repo, pull_number, commit_id,
            path: comment.path,
            line: comment.line,
            side: comment.side,
            body: comment.body
          });
          posted++;
        } catch (commentError: any) {
          console.warn(`Skipping comment on ${comment.path}:${comment.line} (${commentError.message})`);
          skippedComments.push(`<details>\n<summary><b>${comment.path}:${comment.line}</b></summary>\n\n${comment.body}\n</details>`);
          skipped++;
        }
      }

      const fallbackSummary = summary + (skipped > 0
        ? `\n\n### Findings that couldn't be placed inline\n_(line no longer part of the diff, or otherwise rejected — shown here instead)_\n\n${skippedComments.join('\n\n')}`
        : '');
      await this.octokit.rest.issues.createComment({ owner, repo, issue_number: pull_number, body: fallbackSummary });

      return { posted, skipped };
    }
  }

  // The outcome of a createThreadReply attempt. Deliberately NOT a plain
  // boolean or a thrown error — Phase 2b's caller (feedbackLoop.ts, not yet
  // wired up) needs to distinguish "this specific post failed" from "every
  // further post this run will also fail" so it can stop attempting the
  // rest of a capped batch instead of burning maxRepliesPosted more doomed
  // calls one at a time (design doc §5.3: a fork PR's read-only
  // GITHUB_TOKEN degrades the whole loop to observe, not just this one
  // reply).
  //
  // Note: as of this build, nothing calls createThreadReply yet — Phase 2a
  // computes and reports adjudication verdicts in dry-run only (see
  // feedbackLoop.ts). This method exists and is unit-tested now so Phase
  // 2b's interface doesn't have to change when posting is wired up.

  /**
   * Posts a reply into an existing review-comment thread — the write side
   * of the PR comment feedback loop (design doc §5.2). `rootCommentId` must
   * be the thread ROOT, not the comment being answered — passing the wrong
   * id starts a sibling thread instead of replying into the existing one.
   * Never throws.
   */
  public async createThreadReply(url: string, rootCommentId: number, body: string): Promise<
    { posted: true } | { posted: false; reason: 'fork-read-only' | 'error'; message: string }
  > {
    const { owner, repo, pull_number } = this.parsePRUrl(url);
    try {
      await this.octokit.rest.pulls.createReplyForReviewComment({
        owner, repo, pull_number,
        comment_id: rootCommentId,
        body,
      });
      return { posted: true };
    } catch (error: any) {
      if (error?.status === 403) {
        return { posted: false, reason: 'fork-read-only', message: error.message || 'Forbidden' };
      }
      return { posted: false, reason: 'error', message: error?.message || String(error) };
    }
  }

  // deriveGsrLastReply computes a thread's round/ack/verdict state from
  // GSR's own previously-posted reply comments (already trust-checked by
  // the caller — see TRUSTED_GSR_BOT_LOGIN). This is the only place that
  // state exists; there is no database (design doc §4).
  //
  // Fail-closed by construction (design-review finding): a trusted-login
  // reply comment that carries EITHER a well-formed gsr-reply:v1 marker OR
  // malformed/absent marker syntax always counts as "GSR has already
  // replied here" — never as round 0. A parser bug, a format drift, or a
  // future code path that posts under this identity without appending a
  // marker must suppress a further rebuttal, never silently permit a
  // second one. The fail-closed round uses Number.MAX_SAFE_INTEGER rather
  // than a fixed "1" specifically so it can't under-count against whatever
  // round cap feedbackLoop.ts is configured with — this module doesn't need
  // to know that cap's value to still fail safely.
  //
  // When multiple trusted replies exist in one thread (should be at most
  // one per the product's "one rebuttal per thread, ever" rule, but a race
  // between two concurrent runs could momentarily produce two), round and
  // ack are each taken as independent maximums rather than "whichever
  // comment has the highest round" — so a lower-ack duplicate can't
  // un-suppress replies the other run already accounted for.
  private static deriveGsrLastReply(
    trustedReplyComments: { id: number; body?: string | null }[]
  ): FindingThread['gsrLastReply'] {
    if (trustedReplyComments.length === 0) return undefined;

    let maxRound = 0;
    let maxAck = 0;
    let latestRoundSeen = -1;
    let verdict: AdjudicationVerdict = 'unclear';
    let confidence = 0;

    for (const c of trustedReplyComments) {
      const marker = parseReplyMarker(c.body || '');
      if (marker) {
        maxRound = Math.max(maxRound, marker.round);
        maxAck = Math.max(maxAck, marker.ackCommentId);
        if (marker.round >= latestRoundSeen) {
          latestRoundSeen = marker.round;
          verdict = marker.verdict;
          confidence = marker.confidence;
        }
      } else {
        maxRound = Math.max(maxRound, Number.MAX_SAFE_INTEGER);
        maxAck = Math.max(maxAck, c.id);
      }
    }

    return { round: maxRound, ackCommentId: maxAck, verdict, confidence };
  }

  // Hard cap on review comments fetched per listReviewThreads() call
  // (design doc §13's failure-modes table) — a pathological PR with
  // hundreds/thousands of comments shouldn't make the feedback pass scan
  // unboundedly.
  private static readonly MAX_COMMENTS_FETCHED = 500;

  // Groups the flat comments list into threads keyed by root comment id.
  // GitHub's REST docs describe `in_reply_to_id` as "the id of the comment
  // being replied to", which in practice is generally the thread ROOT for
  // every reply in a thread rather than the immediate parent — but the
  // implementation must not assume that (design doc §5.1, open question 1):
  // this walks `in_reply_to_id` transitively until it reaches a comment with
  // none, and treats that as the root. Correct either way, one extra loop.
  private static groupRepliesByRoot(comments: { id: number; in_reply_to_id?: number }[]): Map<number, typeof comments> {
    const byId = new Map<number, { id: number; in_reply_to_id?: number }>();
    for (const c of comments) byId.set(c.id, c);

    // Self-review finding: only caching the walk's STARTING id (not every
    // node visited along the way) makes resolveRootId O(N) per call on a
    // reply chain of depth N, and this is called once per comment in the
    // flat list — O(N²) total on a single deep chain. Caching every visited
    // node (path-compression style) makes each walk touch already-cached
    // nodes after the first, bringing the whole grouping pass back to
    // amortized O(N). Bounded in practice either way (MAX_COMMENTS_FETCHED
    // caps N at 500), but cheap to do properly.
    const rootIdCache = new Map<number, number>();
    const resolveRootId = (startId: number): number => {
      const cached = rootIdCache.get(startId);
      if (cached !== undefined) return cached;

      const path: number[] = [];
      const visited = new Set<number>();
      let current = byId.get(startId);
      let rootId = startId;
      while (current?.in_reply_to_id != null && !visited.has(current.id)) {
        const cachedAhead = rootIdCache.get(current.id);
        if (cachedAhead !== undefined) {
          rootId = cachedAhead;
          break;
        }
        path.push(current.id);
        visited.add(current.id);
        rootId = current.in_reply_to_id;
        current = byId.get(current.in_reply_to_id);
      }
      for (const id of path) rootIdCache.set(id, rootId);
      rootIdCache.set(startId, rootId);
      return rootId;
    };

    const grouped = new Map<number, typeof comments>();
    for (const c of comments) {
      if (c.in_reply_to_id == null) continue; // a root isn't grouped as its own reply
      const rootId = resolveRootId(c.id);
      if (!grouped.has(rootId)) grouped.set(rootId, []);
      grouped.get(rootId)!.push(c);
    }

    // Self-review finding: a finding with zero replies never got a `grouped`
    // entry at all (only replies create one, keyed by their resolved root),
    // so listReviewThreads silently dropped every not-yet-answered GSR
    // finding from its output. Doesn't affect Phase 1's current behavior
    // (nothing to classify on a thread with no replies either way — see
    // feedbackLoop.ts's groupByFinding, which already skips empty-reply
    // threads), but listReviewThreads is a general read method and should
    // return every GSR thread that exists, not only the ones with activity.
    for (const c of comments) {
      if (c.in_reply_to_id == null && !grouped.has(c.id)) grouped.set(c.id, []);
    }

    return grouped;
  }

  /**
   * Reads every review-comment thread on a PR and returns the ones GSR
   * itself started — the read side of the PR comment feedback loop
   * (pr-comment-feedback-loop-design.md §4–§5). No writes; Phase 2's
   * createThreadReply is a separate, not-yet-implemented method.
   *
   * A thread's root is only trusted as "GSR's own finding" when it's
   * authored by TRUSTED_GSR_BOT_LOGIN AND carries a well-formed gsr:v1
   * marker (or, for pre-marker comments, parses via the legacy fallback) —
   * see that constant's comment for why login, not `user.type`, is the
   * trust boundary. Untrusted roots (including ones a non-GSR author
   * hand-typed to look like a marker) are silently skipped, never guessed
   * at.
   */
  public async listReviewThreads(url: string): Promise<FindingThread[]> {
    const { owner, repo, pull_number } = this.parsePRUrl(url);

    // Stops requesting further pages once MAX_COMMENTS_FETCHED is reached
    // (security-review finding: the cap previously only truncated the
    // in-memory array *after* `paginate` had already walked every page —
    // on a PR with thousands of review comments, that still burned the
    // Action's GitHub API rate-limit budget fetching pages that were
    // immediately discarded). May overshoot by up to one page's worth
    // before the `done()` call takes effect; the slice below makes the
    // final count exact regardless.
    let fetchedCount = 0;
    // Self-review finding: when the PR's actual comment count is an exact
    // multiple of per_page landing beyond the cap (e.g. exactly 500, 600...),
    // `comments.length > MAX_COMMENTS_FETCHED` is false even though pagination
    // WAS stopped early — `done()` fires, but the fetched count only ever
    // equals the cap, never exceeds it, so the warning silently didn't fire
    // on exactly the PRs it exists to warn about. Track whether we actually
    // stopped early instead of inferring it from a length comparison.
    let stoppedEarly = false;
    let comments = await this.octokit.paginate(
      this.octokit.rest.pulls.listReviewComments,
      { owner, repo, pull_number, per_page: 100, sort: 'created', direction: 'asc' },
      (response, done) => {
        fetchedCount += response.data.length;
        if (fetchedCount >= GitHubClient.MAX_COMMENTS_FETCHED) {
          stoppedEarly = true;
          done();
        }
        return response.data;
      }
    );

    if (stoppedEarly || comments.length > GitHubClient.MAX_COMMENTS_FETCHED) {
      console.warn(`[GitHubClient] PR has at least ${comments.length} review comments; capping feedback-loop scan to the first ${GitHubClient.MAX_COMMENTS_FETCHED}.`);
      comments = comments.slice(0, GitHubClient.MAX_COMMENTS_FETCHED);
    }

    const byId = new Map<number, (typeof comments)[number]>();
    for (const c of comments) byId.set(c.id, c);

    const grouped = GitHubClient.groupRepliesByRoot(comments as any);

    const threads: FindingThread[] = [];
    for (const [rootId, replyComments] of grouped) {
      const root = byId.get(rootId);
      if (!root) continue; // shouldn't happen, but a truncated/paginated window is defensive-programming territory

      // Trust check (design doc §9, T2) — see TRUSTED_GSR_BOT_LOGIN.
      if (root.user?.login !== TRUSTED_GSR_BOT_LOGIN) continue;

      const rootBody = root.body || '';
      let findingId: string;
      let agent: string | undefined;
      let severity: CandidateFinding['severity'] | undefined;
      let promptVersion: string | undefined;

      // The visible header line (`emoji **SEVERITY** · agent — summary`)
      // hasn't changed shape since before markers existed, so this recovers
      // `summary` for classifier context regardless of whether the thread
      // has a marker — the marker itself never carries summary text.
      const headerInfo = parseLegacyFindingBody(rootBody);

      const marker = parseFindingMarker(rootBody);
      if (marker) {
        findingId = marker.findingId;
        agent = marker.agent;
        severity = marker.severity as CandidateFinding['severity'] | undefined;
        promptVersion = marker.promptVersion;
      } else {
        // Pre-marker (legacy) comment fallback (design doc §4.3). If this
        // also fails, skip the thread entirely rather than guess at a
        // findingId.
        //
        // Self-review finding: `line` is the comment's position in the
        // CURRENT diff and can shift (or go null) after a force-push or
        // rebase; `original_line` is fixed at comment-creation time. Using
        // `line` here meant a legacy finding's id — its only correlation
        // key, since it has no marker — could silently change between
        // runs. Prefer `original_line`, falling back to `line` only if a
        // comment predates that field being populated.
        const legacyLine = root.original_line ?? root.line;
        if (!headerInfo || root.path == null || legacyLine == null) continue;
        findingId = computeFindingId({ file: root.path, line: legacyLine, agent: headerInfo.agent, summary: headerInfo.summary });
        agent = headerInfo.agent;
        severity = headerInfo.severity as CandidateFinding['severity'];
      }

      // Exclude GSR's own comments from `replies` — Phase 2 posts rebuttals
      // authored by TRUSTED_GSR_BOT_LOGIN into these same threads, and this
      // loop only wants what a developer (or their coding agent) said back,
      // not GSR talking to itself. GSR's own replies are captured
      // separately below to derive round/ack state (deriveGsrLastReply).
      const trustedReplyComments = (replyComments as any[]).filter(c => c.user?.login === TRUSTED_GSR_BOT_LOGIN);
      const gsrLastReply = GitHubClient.deriveGsrLastReply(trustedReplyComments);

      const replies: ThreadReply[] = (replyComments as any[])
        .filter(c => c.user?.login !== TRUSTED_GSR_BOT_LOGIN)
        .sort((a, b) => a.id - b.id)
        .map(c => ({
          commentId: c.id,
          author: c.user?.login || 'unknown',
          isBot: c.user?.type === 'Bot',
          createdAt: c.created_at,
          body: c.body || '',
        }));

      threads.push({
        rootCommentId: rootId,
        htmlUrl: root.html_url,
        findingId,
        agent,
        severity,
        promptVersion,
        summary: headerInfo?.summary,
        // path/original_line come straight from the API, not the marker
        // (the marker has no file= field) — used by feedbackLoop.ts to look
        // up a matching diff hunk for adjudication context (design doc
        // §8.3 item 3). original_line preferred over line for the same
        // rebase-stability reason as the legacy-fallback path above.
        path: root.path ?? undefined,
        line: root.original_line ?? root.line ?? undefined,
        rootBody,
        gsrLastReply,
        replies,
      });
    }

    return threads;
  }
}
