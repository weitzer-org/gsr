import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { runFeedbackPass, formatFeedbackSummaryMarkdown, escapeFeedbackResultForApiResponse, FeedbackPassResult } from '../src/feedbackLoop';
import { AdjudicatorAgent } from '../src/adjudicator';
import { FindingThread } from '../src/types';

function thread(overrides: Partial<FindingThread> = {}): FindingThread {
  return {
    rootCommentId: 1,
    htmlUrl: 'https://github.com/x/y/pull/1#discussion_r1',
    findingId: 'abc123def4567890',
    agent: 'Logic',
    severity: 'HIGH',
    promptVersion: 'system_prompts',
    summary: 'some finding',
    replies: [],
    ...overrides,
  };
}

function mockGh(threads: FindingThread[], opts: { throws?: Error } = {}) {
  return {
    listReviewThreads: opts.throws
      ? (jest.fn() as any).mockRejectedValue(opts.throws)
      : (jest.fn() as any).mockResolvedValue(threads),
    // Phase 2a invariant under test throughout this file: runFeedbackPass
    // must NEVER call this, in any mode, regardless of what adjudication
    // decides — see the "Phase 2a never posts" describe block below.
    createThreadReply: jest.fn(),
  } as any;
}

describe('runFeedbackPass', () => {
  // Self-review finding: process.env is process-global — restore it after
  // each test so setting GEMINI_API_KEY here can't leak into a later test
  // file in the same worker. Matches tests/agent.test.ts's convention.
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    process.env.GEMINI_API_KEY = 'test-key';
  });

  afterEach(() => {
    jest.restoreAllMocks();
    // Self-review finding, confirmed by direct testing: process.env = X
    // replaces Node's special environment binding with a plain object,
    // permanently losing its auto-stringification (and OS-sync) behavior
    // for the rest of the process — verified empirically that a value
    // assigned to process.env AFTER a wholesale reassignment like this no
    // longer coerces to a string the way it does before one. Restoring
    // key-by-key onto the still-special object avoids that.
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  });

  it('mode "off": returns a skipped result and never calls listReviewThreads', async () => {
    const gh = mockGh([]);
    const result = await runFeedbackPass(gh, 'https://github.com/x/y/pull/1', { mode: 'off' });

    expect(result).toMatchObject({ mode: 'off', skipped: true, threadsScanned: 0, findings: [] });
    expect(gh.listReviewThreads).not.toHaveBeenCalled();
  });

  it('mode "observe" with no threads: scans and returns an empty, non-skipped result with no Gemini call', async () => {
    const gh = mockGh([]);
    const classifySpy = jest.spyOn(AdjudicatorAgent.prototype, 'classifyReplies');

    const result = await runFeedbackPass(gh, 'https://github.com/x/y/pull/1', { mode: 'observe' });

    expect(result.skipped).toBe(false);
    expect(result.threadsScanned).toBe(0);
    expect(result.findings).toEqual([]);
    expect(classifySpy).not.toHaveBeenCalled();
  });

  it('stage 0 is free: zero surviving replies after filtering means zero Gemini calls', async () => {
    const t = thread({
      replies: [
        { commentId: 2, author: 'coderabbitai[bot]', isBot: true, createdAt: 't', body: 'looks good to me' },
        { commentId: 3, author: 'a-developer', isBot: false, createdAt: 't', body: '👍' },
      ],
    });
    const gh = mockGh([t]);
    const classifySpy = jest.spyOn(AdjudicatorAgent.prototype, 'classifyReplies');

    const result = await runFeedbackPass(gh, 'https://github.com/x/y/pull/1', { mode: 'observe' });

    expect(result.repliesClassified).toBe(0);
    expect(result.findings).toEqual([]);
    expect(classifySpy).not.toHaveBeenCalled();
  });

  it('never throws: a listReviewThreads failure yields a skipped result instead of propagating', async () => {
    const gh = mockGh([], { throws: new Error('GitHub API down') });
    jest.spyOn(console, 'error').mockImplementation(() => {});

    const result = await runFeedbackPass(gh, 'https://github.com/x/y/pull/1', { mode: 'observe' });

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toContain('GitHub API down');
  });

  describe('mode "respond" — Phase 2a adjudication (dry run, adjudicates for real, never posts)', () => {
    function mockAdjudicate(result: Partial<{
      verdict: 'pushback_correct' | 'pushback_incorrect' | 'unclear';
      confidence: number;
      reasoning: string;
      rebuttalMarkdown: string;
      fenceDetected: boolean;
    }>) {
      return jest.spyOn(AdjudicatorAgent.prototype, 'adjudicate').mockResolvedValue({
        verdict: 'unclear',
        confidence: 0,
        reasoning: '',
        rebuttalMarkdown: '',
        fenceDetected: false,
        ...result,
      });
    }

    it('adjudicates a rejected reply and reports a would-post decision, but never calls createThreadReply', async () => {
      const t = thread({
        replies: [{ commentId: 2, author: 'a-developer', isBot: false, createdAt: 't', body: 'disagree, this is intentional' }],
      });
      const gh = mockGh([t]);
      jest.spyOn(AdjudicatorAgent.prototype, 'classifyReplies').mockResolvedValue([
        { commentId: 2, stance: 'rejected', confidence: 0.8 },
      ]);
      const adjudicateSpy = mockAdjudicate({ verdict: 'pushback_incorrect', confidence: 0.9, reasoning: 'still stands', rebuttalMarkdown: 'Here is why it still stands.' });

      const result = await runFeedbackPass(gh, 'https://github.com/x/y/pull/1', { mode: 'respond' });

      expect(adjudicateSpy).toHaveBeenCalledTimes(1);
      expect(result.repliesAdjudicated).toBe(1);
      const adjudication = result.findings[0].replies[0].adjudication;
      expect(adjudication).toMatchObject({ verdict: 'pushback_incorrect', wouldPost: true });
      expect(adjudication?.rebuttalMarkdown).toBe('Here is why it still stands.');
      expect(gh.createThreadReply).not.toHaveBeenCalled();
    });

    it('never adjudicates a reply that was not classified "rejected"', async () => {
      const t = thread({
        replies: [{ commentId: 2, author: 'a-developer', isBot: false, createdAt: 't', body: 'fixed it' }],
      });
      const gh = mockGh([t]);
      jest.spyOn(AdjudicatorAgent.prototype, 'classifyReplies').mockResolvedValue([
        { commentId: 2, stance: 'accepted', confidence: 0.9 },
      ]);
      const adjudicateSpy = mockAdjudicate({});

      const result = await runFeedbackPass(gh, 'https://github.com/x/y/pull/1', { mode: 'respond' });

      expect(adjudicateSpy).not.toHaveBeenCalled();
      expect(result.findings[0].replies[0].adjudication).toBeUndefined();
    });

    it('stop-condition layer 2: never adjudicates a bot-authored reply, even when classified "rejected"', async () => {
      const t = thread({
        replies: [{ commentId: 2, author: 'some-coding-agent[bot]', isBot: true, createdAt: 't', body: 'disagree, false positive' }],
      });
      const gh = mockGh([t]);
      jest.spyOn(AdjudicatorAgent.prototype, 'classifyReplies').mockResolvedValue([
        { commentId: 2, stance: 'rejected', confidence: 0.8 },
      ]);
      const adjudicateSpy = mockAdjudicate({ verdict: 'pushback_incorrect', confidence: 0.9 });

      const result = await runFeedbackPass(gh, 'https://github.com/x/y/pull/1', { mode: 'respond' });

      expect(adjudicateSpy).not.toHaveBeenCalled();
      expect(result.findings[0].replies[0].adjudication).toBeUndefined();
    });

    it('stop-condition layer 1: a thread already at the round cap still gets its new rejection CLASSIFIED (§8.4 — ' +
       '"records the second rejection"), but does not adjudicate it', async () => {
      const t = thread({
        gsrLastReply: { round: 1, ackCommentId: 5, verdict: 'pushback_incorrect', confidence: 0.9 },
        replies: [{ commentId: 6, author: 'a-developer', isBot: false, createdAt: 't', body: 'still disagree' }],
      });
      const gh = mockGh([t]);
      const classifySpy = jest.spyOn(AdjudicatorAgent.prototype, 'classifyReplies').mockResolvedValue([
        { commentId: 6, stance: 'rejected', confidence: 0.8 },
      ]);
      const adjudicateSpy = mockAdjudicate({});

      const result = await runFeedbackPass(gh, 'https://github.com/x/y/pull/1', { mode: 'respond' });

      expect(classifySpy).toHaveBeenCalledTimes(1); // still classified — the signal is recorded
      expect(result.findings[0].replies[0].stance).toBe('rejected');
      expect(adjudicateSpy).not.toHaveBeenCalled(); // but never adjudicated/argued with again
      expect(result.findings[0].replies[0].adjudication).toBeUndefined();
    });

    it('the ack filter (thread-local) drops an already-answered reply from Stage 0 entirely — not classified either', async () => {
      const t = thread({
        gsrLastReply: { round: 1, ackCommentId: 5, verdict: 'pushback_incorrect', confidence: 0.9 },
        replies: [{ commentId: 5, author: 'a-developer', isBot: false, createdAt: 't', body: 'already-seen reply' }],
      });
      const gh = mockGh([t]);
      const classifySpy = jest.spyOn(AdjudicatorAgent.prototype, 'classifyReplies');

      const result = await runFeedbackPass(gh, 'https://github.com/x/y/pull/1', { mode: 'respond' });

      expect(classifySpy).not.toHaveBeenCalled();
      expect(result.findings).toEqual([]);
    });

    it('round cap aggregates PER FINDING across duplicate threads (amendment #5): a never-replied-to duplicate ' +
       'thread for the same finding is still blocked from adjudication once a sibling thread has used its round', async () => {
      const threadA = thread({
        rootCommentId: 1, findingId: 'dup1234dup123456',
        gsrLastReply: { round: 1, ackCommentId: 100, verdict: 'pushback_incorrect', confidence: 0.9 },
        replies: [{ commentId: 101, author: 'a-developer', isBot: false, createdAt: 't', body: 'still disagree in thread A' }],
      });
      const threadB = thread({
        rootCommentId: 2, findingId: 'dup1234dup123456', // same finding, a genuine duplicate thread GSR never replied to
        replies: [{ commentId: 200, author: 'a-developer', isBot: false, createdAt: 't', body: 'disagree in thread B' }],
      });
      const gh = mockGh([threadA, threadB]);
      jest.spyOn(AdjudicatorAgent.prototype, 'classifyReplies').mockResolvedValue([
        { commentId: 101, stance: 'rejected', confidence: 0.8 },
        { commentId: 200, stance: 'rejected', confidence: 0.8 },
      ]);
      const adjudicateSpy = mockAdjudicate({});

      const result = await runFeedbackPass(gh, 'https://github.com/x/y/pull/1', { mode: 'respond' });

      // Both replies were classified (useful signal either way)...
      expect(result.repliesClassified).toBe(2);
      // ...but NEITHER was adjudicated: the finding has already used its one round, in thread A.
      expect(adjudicateSpy).not.toHaveBeenCalled();
      expect(result.repliesAdjudicated).toBe(0);
    });

    it('minConfidence gates a would-post decision: pushback_incorrect below the floor does not post', async () => {
      const t = thread({
        replies: [{ commentId: 2, author: 'a-developer', isBot: false, createdAt: 't', body: 'disagree' }],
      });
      const gh = mockGh([t]);
      jest.spyOn(AdjudicatorAgent.prototype, 'classifyReplies').mockResolvedValue([
        { commentId: 2, stance: 'rejected', confidence: 0.8 },
      ]);
      mockAdjudicate({ verdict: 'pushback_incorrect', confidence: 0.5 });

      const result = await runFeedbackPass(gh, 'https://github.com/x/y/pull/1', { mode: 'respond', minConfidence: 0.7 });

      const adjudication = result.findings[0].replies[0].adjudication;
      expect(adjudication?.verdict).toBe('pushback_incorrect');
      expect(adjudication?.wouldPost).toBe(false);
      expect(adjudication?.suppressedReason).toBeUndefined(); // never eligible in the first place, not "suppressed"
    });

    it('pushback_correct and unclear verdicts never post regardless of confidence', async () => {
      const t = thread({
        replies: [{ commentId: 2, author: 'a-developer', isBot: false, createdAt: 't', body: 'disagree' }],
      });
      const gh = mockGh([t]);
      jest.spyOn(AdjudicatorAgent.prototype, 'classifyReplies').mockResolvedValue([
        { commentId: 2, stance: 'rejected', confidence: 0.8 },
      ]);
      mockAdjudicate({ verdict: 'pushback_correct', confidence: 0.99 });

      const result = await runFeedbackPass(gh, 'https://github.com/x/y/pull/1', { mode: 'respond' });

      expect(result.findings[0].replies[0].adjudication?.wouldPost).toBe(false);
    });

    it('maxRepliesPosted caps would-post decisions per run; the excess is reported as suppressed, not silently dropped', async () => {
      const threadA = thread({
        rootCommentId: 1, findingId: 'aaaa1111aaaa1111', severity: 'HIGH',
        replies: [{ commentId: 10, author: 'dev1', isBot: false, createdAt: 't', body: 'disagree A' }],
      });
      const threadB = thread({
        rootCommentId: 2, findingId: 'bbbb2222bbbb2222', severity: 'HIGH',
        replies: [{ commentId: 20, author: 'dev2', isBot: false, createdAt: 't', body: 'disagree B' }],
      });
      const gh = mockGh([threadA, threadB]);
      jest.spyOn(AdjudicatorAgent.prototype, 'classifyReplies').mockResolvedValue([
        { commentId: 10, stance: 'rejected', confidence: 0.8 },
        { commentId: 20, stance: 'rejected', confidence: 0.8 },
      ]);
      mockAdjudicate({ verdict: 'pushback_incorrect', confidence: 0.9 });

      const result = await runFeedbackPass(gh, 'https://github.com/x/y/pull/1', { mode: 'respond', maxRepliesPosted: 1 });

      const decisions = result.findings.flatMap(f => f.replies).map(r => r.adjudication!);
      const wouldPostCount = decisions.filter(d => d.wouldPost).length;
      const suppressedCount = decisions.filter(d => !d.wouldPost && d.suppressedReason === 'per-run-cap').length;
      expect(wouldPostCount).toBe(1);
      expect(suppressedCount).toBe(1);
    });

    it('dedupes would-post decisions by findingId across duplicate threads for the SAME finding (amendment #5)', async () => {
      const threadA = thread({
        rootCommentId: 1, findingId: 'dup1234dup123456',
        replies: [{ commentId: 10, author: 'dev1', isBot: false, createdAt: 't', body: 'disagree A' }],
      });
      const threadB = thread({
        rootCommentId: 2, findingId: 'dup1234dup123456', // duplicate thread, same finding
        replies: [{ commentId: 20, author: 'dev2', isBot: false, createdAt: 't', body: 'disagree B' }],
      });
      const gh = mockGh([threadA, threadB]);
      jest.spyOn(AdjudicatorAgent.prototype, 'classifyReplies').mockResolvedValue([
        { commentId: 10, stance: 'rejected', confidence: 0.8 },
        { commentId: 20, stance: 'rejected', confidence: 0.8 },
      ]);
      mockAdjudicate({ verdict: 'pushback_incorrect', confidence: 0.9 });

      const result = await runFeedbackPass(gh, 'https://github.com/x/y/pull/1', { mode: 'respond', maxRepliesPosted: 3 });

      const decisions = result.findings.flatMap(f => f.replies).map(r => r.adjudication!);
      expect(decisions.filter(d => d.wouldPost)).toHaveLength(1);
      expect(decisions.filter(d => d.suppressedReason === 'duplicate-thread-same-finding')).toHaveLength(1);
    });

    it('reports "duplicate-thread-same-finding", not "per-run-cap", when BOTH conditions hold at once — a ' +
       'duplicate thread for a finding that already posted, arriving after the cap is also exhausted (PR #61 ' +
       'self-review + CodeRabbit finding, independently flagged twice: the duplicate check must take precedence ' +
       'since the report is what a human reads to decide whether raising the cap would help — it would not)', async () => {
      const threadA = thread({
        rootCommentId: 1, findingId: 'dup1234dup123456', severity: 'HIGH',
        replies: [{ commentId: 10, author: 'dev1', isBot: false, createdAt: 't', body: 'disagree A' }],
      });
      const threadB = thread({
        rootCommentId: 2, findingId: 'dup1234dup123456', severity: 'HIGH', // same finding as A
        replies: [{ commentId: 20, author: 'dev2', isBot: false, createdAt: 't', body: 'disagree B' }],
      });
      const gh = mockGh([threadA, threadB]);
      jest.spyOn(AdjudicatorAgent.prototype, 'classifyReplies').mockResolvedValue([
        { commentId: 10, stance: 'rejected', confidence: 0.8 },
        { commentId: 20, stance: 'rejected', confidence: 0.8 },
      ]);
      mockAdjudicate({ verdict: 'pushback_incorrect', confidence: 0.9 });

      // maxRepliesPosted: 1 — A alone exhausts the cap, so by the time B is
      // evaluated, BOTH "cap exhausted" and "duplicate of an already-posted
      // finding" are true simultaneously.
      const result = await runFeedbackPass(gh, 'https://github.com/x/y/pull/1', { mode: 'respond', maxRepliesPosted: 1 });

      const decisions = result.findings.flatMap(f => f.replies).map(r => r.adjudication!);
      expect(decisions.filter(d => d.wouldPost)).toHaveLength(1);
      const suppressed = decisions.find(d => !d.wouldPost)!;
      expect(suppressed.suppressedReason).toBe('duplicate-thread-same-finding');
    });

    it('still labels a SECOND duplicate correctly even when the FIRST duplicate never itself posted — both ' +
       'suppressed by an unrelated finding\'s cap usage (PR #61 self-review finding, round 2: reordering the ' +
       'checks alone was not enough — seenFindingIds only got populated in the would-post branch, so a finding ' +
       'whose first occurrence was itself cap-suppressed (never added to the set) let a LATER duplicate of that ' +
       'same finding also report per-run-cap instead of duplicate-thread-same-finding, since the set never learned ' +
       'about it)', async () => {
      const threadX = thread({
        rootCommentId: 1, findingId: 'xxxx0000xxxx0000', severity: 'CRITICAL', // unrelated finding, uses the cap
        replies: [{ commentId: 5, author: 'dev0', isBot: false, createdAt: 't', body: 'disagree X' }],
      });
      const threadA = thread({
        rootCommentId: 2, findingId: 'dup1234dup123456', severity: 'HIGH',
        replies: [{ commentId: 10, author: 'dev1', isBot: false, createdAt: 't', body: 'disagree A' }],
      });
      const threadB = thread({
        rootCommentId: 3, findingId: 'dup1234dup123456', severity: 'HIGH', // duplicate of A
        replies: [{ commentId: 20, author: 'dev2', isBot: false, createdAt: 't', body: 'disagree B' }],
      });
      const gh = mockGh([threadX, threadA, threadB]);
      jest.spyOn(AdjudicatorAgent.prototype, 'classifyReplies').mockResolvedValue([
        { commentId: 5, stance: 'rejected', confidence: 0.8 },
        { commentId: 10, stance: 'rejected', confidence: 0.8 },
        { commentId: 20, stance: 'rejected', confidence: 0.8 },
      ]);
      mockAdjudicate({ verdict: 'pushback_incorrect', confidence: 0.9 });

      // maxRepliesPosted: 1 — X (CRITICAL, processed first by severity) uses
      // the only slot. A and B never get a chance to post, regardless of
      // which one is "first" — but B must still be recognized as a
      // duplicate of A, not just another cap casualty.
      const result = await runFeedbackPass(gh, 'https://github.com/x/y/pull/1', { mode: 'respond', maxRepliesPosted: 1 });

      const decisions = result.findings.flatMap(f => f.replies).map(r => r.adjudication!);
      expect(decisions.filter(d => d.wouldPost)).toHaveLength(1); // only X posts
      const dupFindingDecisions = result.findings.find(f => f.findingId === 'dup1234dup123456')!.replies.map(r => r.adjudication!);
      expect(dupFindingDecisions.find(d => d.suppressedReason === 'per-run-cap')).toBeDefined(); // A: first occurrence, cap-suppressed
      expect(dupFindingDecisions.find(d => d.suppressedReason === 'duplicate-thread-same-finding')).toBeDefined(); // B: duplicate of A
    });

    it('maxAdjudications caps how many rejections get an adjudicate() call, preferring higher severity', async () => {
      const lowThread = thread({
        rootCommentId: 1, findingId: 'low1111low111111', severity: 'LOW',
        replies: [{ commentId: 10, author: 'dev1', isBot: false, createdAt: 't', body: 'disagree low' }],
      });
      const criticalThread = thread({
        rootCommentId: 2, findingId: 'crit222crit222222', severity: 'CRITICAL',
        replies: [{ commentId: 20, author: 'dev2', isBot: false, createdAt: 't', body: 'disagree critical' }],
      });
      const gh = mockGh([lowThread, criticalThread]);
      jest.spyOn(AdjudicatorAgent.prototype, 'classifyReplies').mockResolvedValue([
        { commentId: 10, stance: 'rejected', confidence: 0.8 },
        { commentId: 20, stance: 'rejected', confidence: 0.8 },
      ]);
      const adjudicateSpy = mockAdjudicate({ verdict: 'pushback_incorrect', confidence: 0.9 });

      const result = await runFeedbackPass(gh, 'https://github.com/x/y/pull/1', { mode: 'respond', maxAdjudications: 1 });

      expect(adjudicateSpy).toHaveBeenCalledTimes(1);
      expect(adjudicateSpy.mock.calls[0][0]).toMatchObject({ findingId: 'crit222crit222222' });
      expect(result.repliesAdjudicated).toBe(1);
    });

    it('passes the matching diff hunk for the thread\'s path, when currentDiff is provided', async () => {
      const t = thread({
        path: 'app.py',
        replies: [{ commentId: 2, author: 'a-developer', isBot: false, createdAt: 't', body: 'disagree' }],
      });
      const gh = mockGh([t]);
      jest.spyOn(AdjudicatorAgent.prototype, 'classifyReplies').mockResolvedValue([
        { commentId: 2, stance: 'rejected', confidence: 0.8 },
      ]);
      const adjudicateSpy = mockAdjudicate({});

      await runFeedbackPass(gh, 'https://github.com/x/y/pull/1', {
        mode: 'respond',
        currentDiff: [{ file: 'app.py', content: '@@ -1,1 +1,1 @@\n-old\n+new' }, { file: 'other.py', content: 'irrelevant' }],
      });

      expect(adjudicateSpy.mock.calls[0][0]).toMatchObject({ diffHunk: '@@ -1,1 +1,1 @@\n-old\n+new' });
    });

    it('never calls createThreadReply anywhere, regardless of adjudication outcome (the Phase 2a/2b boundary)', async () => {
      const t = thread({
        replies: [{ commentId: 2, author: 'a-developer', isBot: false, createdAt: 't', body: 'disagree' }],
      });
      const gh = mockGh([t]);
      jest.spyOn(AdjudicatorAgent.prototype, 'classifyReplies').mockResolvedValue([
        { commentId: 2, stance: 'rejected', confidence: 0.8 },
      ]);
      mockAdjudicate({ verdict: 'pushback_incorrect', confidence: 0.99 });

      await runFeedbackPass(gh, 'https://github.com/x/y/pull/1', { mode: 'respond' });

      expect(gh.createThreadReply).not.toHaveBeenCalled();
    });
  });

  describe('bodyExcerpt sanitization (security-review finding: raw reply text reached the HTTP response)', () => {
    it('HTML-entity-escapes a reply body before it reaches the report, since /api/review streams it to the browser', async () => {
      const t = thread({
        replies: [{
          commentId: 2, author: 'attacker', isBot: false, createdAt: 't',
          body: '<img src=x onerror=alert(document.cookie)> & "quoted"',
        }],
      });
      const gh = mockGh([t]);
      jest.spyOn(AdjudicatorAgent.prototype, 'classifyReplies').mockResolvedValue([
        { commentId: 2, stance: 'neutral', confidence: 0.5 },
      ]);

      const result = await runFeedbackPass(gh, 'https://github.com/x/y/pull/1', { mode: 'observe' });

      const excerpt = result.findings[0].replies[0].bodyExcerpt;
      expect(excerpt).not.toContain('<img');
      expect(excerpt).not.toContain('"quoted"');
      expect(excerpt).toBe('&lt;img src=x onerror=alert(document.cookie)&gt; &amp; &quot;quoted&quot;');
    });

    it('runFeedbackPass itself leaves finding-level summary/agent/promptVersion RAW (self-review finding: ' +
       'these used to get HTML-escaped inside groupByFinding, but that\'s a shared shape also consumed by the ' +
       'Markdown-only Job Summary formatter, which doesn\'t want HTML entities — escaping now happens only at ' +
       'the actual API-response boundary, via escapeFeedbackResultForApiResponse, see the next test)', async () => {
      const t = thread({
        agent: '<script>alert(1)</script>',
        summary: 'finding with "quotes" & <tags>',
        promptVersion: 'v<1>',
        replies: [{ commentId: 2, author: 'a-dev', isBot: false, createdAt: 't', body: 'fixed' }],
      });
      const gh = mockGh([t]);
      jest.spyOn(AdjudicatorAgent.prototype, 'classifyReplies').mockResolvedValue([
        { commentId: 2, stance: 'accepted', confidence: 0.9 },
      ]);

      const result = await runFeedbackPass(gh, 'https://github.com/x/y/pull/1', { mode: 'observe' });

      const finding = result.findings[0];
      expect(finding.agent).toBe('<script>alert(1)</script>');
      expect(finding.summary).toBe('finding with "quotes" & <tags>');
      expect(finding.promptVersion).toBe('v<1>');
    });

    it('escapeFeedbackResultForApiResponse HTML-entity-escapes summary/agent/promptVersion for the ' +
       '/api/review JSON response, without mutating the raw result', () => {
      const raw: FeedbackPassResult = {
        mode: 'observe', skipped: false, threadsScanned: 1, repliesClassified: 1, repliesAdjudicated: 0,
        findings: [{
          findingId: 'abc123def4567890', threadUrls: ['https://github.com/x/y/pull/1#discussion_r1'],
          agent: '<script>alert(1)</script>', severity: 'HIGH', promptVersion: 'v<1>',
          summary: 'finding with "quotes" & <tags>',
          replies: [{ commentId: 2, author: 'a-dev', isBot: false, stance: 'accepted', confidence: 0.9, bodyExcerpt: 'ok' }],
        }],
      };

      const escaped = escapeFeedbackResultForApiResponse(raw);

      expect(escaped.findings[0].agent).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
      expect(escaped.findings[0].summary).toBe('finding with &quot;quotes&quot; &amp; &lt;tags&gt;');
      expect(escaped.findings[0].promptVersion).toBe('v&lt;1&gt;');
      // The raw object passed in must be untouched — formatFeedbackSummaryMarkdown
      // (the Job Summary path) needs the unescaped version.
      expect(raw.findings[0].agent).toBe('<script>alert(1)</script>');
    });
  });

  describe('stage-0 bot filtering (review-amendment #4)', () => {
    it('drops known other-reviewer-bot replies (coderabbitai, gemini-code-assist) without classifying them', async () => {
      const t = thread({
        replies: [
          { commentId: 2, author: 'coderabbitai[bot]', isBot: true, createdAt: 't', body: 'nit: consider renaming' },
          { commentId: 3, author: 'gemini-code-assist[bot]', isBot: true, createdAt: 't', body: 'looks fine to me' },
          { commentId: 4, author: 'a-developer', isBot: false, createdAt: 't', body: 'fixed it' },
        ],
      });
      const gh = mockGh([t]);
      const classifySpy = jest.spyOn(AdjudicatorAgent.prototype, 'classifyReplies').mockResolvedValue([
        { commentId: 4, stance: 'accepted', confidence: 0.9 },
      ]);

      await runFeedbackPass(gh, 'https://github.com/x/y/pull/1', { mode: 'observe' });

      const batch = classifySpy.mock.calls[0][0] as any[];
      expect(batch.map(b => b.commentId)).toEqual([4]);
    });

    it('does NOT blanket-drop other bot-authored replies — an AI coding agent reply is classified', async () => {
      const t = thread({
        replies: [
          { commentId: 5, author: 'some-coding-agent[bot]', isBot: true, createdAt: 't', body: 'pushed a fix for this' },
        ],
      });
      const gh = mockGh([t]);
      const classifySpy = jest.spyOn(AdjudicatorAgent.prototype, 'classifyReplies').mockResolvedValue([
        { commentId: 5, stance: 'accepted', confidence: 0.8 },
      ]);

      const result = await runFeedbackPass(gh, 'https://github.com/x/y/pull/1', { mode: 'observe' });

      expect(classifySpy).toHaveBeenCalledTimes(1);
      const batch = classifySpy.mock.calls[0][0] as any[];
      expect(batch.map(b => b.commentId)).toEqual([5]);
      expect(result.findings[0].replies[0].isBot).toBe(true);
    });
  });

  describe('grouping by findingId (review-amendment #5)', () => {
    it('merges two DIFFERENT threads that share the same findingId (duplicate-thread bug scenario) into one report entry', async () => {
      const threadA = thread({
        rootCommentId: 1,
        htmlUrl: 'https://github.com/x/y/pull/1#discussion_r1',
        findingId: 'dup1234dup123456',
        replies: [{ commentId: 10, author: 'a-developer', isBot: false, createdAt: 't', body: 'fixed' }],
      });
      const threadB = thread({
        rootCommentId: 100,
        htmlUrl: 'https://github.com/x/y/pull/1#discussion_r100',
        findingId: 'dup1234dup123456', // same finding, duplicate thread — the known review-quality-design.md §2 bug
        replies: [{ commentId: 11, author: 'a-developer', isBot: false, createdAt: 't', body: 'already fixed this' }],
      });
      const gh = mockGh([threadA, threadB]);
      jest.spyOn(AdjudicatorAgent.prototype, 'classifyReplies').mockResolvedValue([
        { commentId: 10, stance: 'accepted', confidence: 0.9 },
        { commentId: 11, stance: 'accepted', confidence: 0.9 },
      ]);

      const result = await runFeedbackPass(gh, 'https://github.com/x/y/pull/1', { mode: 'observe' });

      expect(result.findings).toHaveLength(1);
      expect(result.findings[0].findingId).toBe('dup1234dup123456');
      expect(result.findings[0].threadUrls).toHaveLength(2);
      // Self-review finding: default .sort() coerces to strings, which
      // happens to give the right order for [10, 11] but is fragile — an
      // explicit numeric comparator makes the intent correct regardless of
      // which numbers are used.
      expect(result.findings[0].replies.map(r => r.commentId).sort((a, b) => a - b)).toEqual([10, 11]);
    });

    it('keeps distinct findingIds as separate report entries', async () => {
      const threadA = thread({
        findingId: 'aaaa1111aaaa1111',
        replies: [{ commentId: 20, author: 'a-developer', isBot: false, createdAt: 't', body: 'fixed' }],
      });
      const threadB = thread({
        rootCommentId: 2,
        findingId: 'bbbb2222bbbb2222',
        replies: [{ commentId: 21, author: 'a-developer', isBot: false, createdAt: 't', body: 'disagree' }],
      });
      const gh = mockGh([threadA, threadB]);
      jest.spyOn(AdjudicatorAgent.prototype, 'classifyReplies').mockResolvedValue([
        { commentId: 20, stance: 'accepted', confidence: 0.9 },
        { commentId: 21, stance: 'rejected', confidence: 0.6 },
      ]);

      const result = await runFeedbackPass(gh, 'https://github.com/x/y/pull/1', { mode: 'observe' });

      expect(result.findings).toHaveLength(2);
      expect(result.findings.map(f => f.findingId).sort()).toEqual(['aaaa1111aaaa1111', 'bbbb2222bbbb2222']);
    });
  });

  describe('maxRepliesClassified cap', () => {
    it('caps the batch sent to Gemini, preferring higher-severity findings', async () => {
      const lowThread = thread({
        rootCommentId: 1, findingId: 'low1111low111111', severity: 'LOW',
        replies: [{ commentId: 1, author: 'dev1', isBot: false, createdAt: 't', body: 'reply 1' }],
      });
      const criticalThread = thread({
        rootCommentId: 2, findingId: 'crit222crit222222', severity: 'CRITICAL',
        replies: [{ commentId: 2, author: 'dev2', isBot: false, createdAt: 't', body: 'reply 2' }],
      });
      const gh = mockGh([lowThread, criticalThread]);
      const classifySpy = jest.spyOn(AdjudicatorAgent.prototype, 'classifyReplies').mockResolvedValue([
        { commentId: 2, stance: 'accepted', confidence: 0.9 },
      ]);

      await runFeedbackPass(gh, 'https://github.com/x/y/pull/1', { mode: 'observe', maxRepliesClassified: 1 });

      const batch = classifySpy.mock.calls[0][0] as any[];
      expect(batch).toHaveLength(1);
      expect(batch[0].commentId).toBe(2); // the CRITICAL finding's reply, not the LOW one
    });

    it('truncates an individual reply\'s text before sending it to Gemini (self-review finding: ' +
       'maxRepliesClassified bounds the batch COUNT, but nothing bounded a single reply\'s own length — a ' +
       'GitHub comment can be up to ~65KB, so an unbounded batch could blow through the model\'s token limit)', async () => {
      const hugeReply = 'x'.repeat(10_000);
      const t = thread({ replies: [{ commentId: 2, author: 'dev', isBot: false, createdAt: 't', body: hugeReply }] });
      const gh = mockGh([t]);
      const classifySpy = jest.spyOn(AdjudicatorAgent.prototype, 'classifyReplies').mockResolvedValue([
        { commentId: 2, stance: 'neutral', confidence: 0.5 },
      ]);

      await runFeedbackPass(gh, 'https://github.com/x/y/pull/1', { mode: 'observe' });

      const batch = classifySpy.mock.calls[0][0] as any[];
      expect(batch[0].replyText.length).toBeLessThan(hugeReply.length);
      expect(batch[0].replyText.length).toBeLessThanOrEqual(4001); // cap + the truncation-marker char
    });
  });

  describe('formatFeedbackSummaryMarkdown (quick-review finding: pipe-escaping)', () => {
    function resultWith(summary: string, agent: string, author: string): FeedbackPassResult {
      return {
        mode: 'observe',
        skipped: false,
        threadsScanned: 1,
        repliesClassified: 1,
        repliesAdjudicated: 0,
        findings: [
          {
            findingId: 'abc123def4567890',
            threadUrls: ['https://github.com/x/y/pull/1#discussion_r1'],
            agent,
            severity: 'HIGH',
            summary,
            replies: [{ commentId: 2, author, isBot: false, stance: 'accepted', confidence: 0.9, bodyExcerpt: 'ok' }],
          },
        ],
      };
    }

    it('escapes a literal "|" in the finding summary so it cannot corrupt the table', () => {
      const md = formatFeedbackSummaryMarkdown(resultWith('uses `cmd | sh` unsafely', 'Security', 'a-dev'));
      const dataRow = md.split('\n').find(l => l.startsWith('| uses'));
      expect(dataRow).toBeDefined();
      // GFM treats a backslash-escaped pipe as a literal character, not a column
      // separator — the unescaped source "|" must never appear in the output.
      expect(dataRow).toContain('cmd \\| sh');
      expect(dataRow).not.toContain('cmd | sh');
    });

    it('escapes "|" in the agent and reply-author fields too', () => {
      const md = formatFeedbackSummaryMarkdown(resultWith('fine', 'Security|Logic', 'weird|login'));
      expect(md).toContain('Security\\|Logic');
      expect(md).toContain('weird\\|login');
    });

    it('does not let a pre-existing backslash-pipe defeat the escaping (self-review finding: escaping "|" alone ' +
       'turns an existing "\\|" into "\\\\|", which GFM reads as an escaped backslash followed by an UNESCAPED ' +
       'pipe — a real column separator again)', () => {
      const md = formatFeedbackSummaryMarkdown(resultWith('a value ending in \\| right here', 'Security', 'a-dev'));
      const dataRow = md.split('\n').find(l => l.startsWith('| a value'));
      expect(dataRow).toBeDefined();
      // Correctly escaped: the pre-existing backslash becomes "\\", and the
      // pipe becomes "\|" — four characters total, not three.
      expect(dataRow).toContain('a value ending in \\\\\\| right here');
      // The table must still be exactly 4 cells — an unescaped "|" here
      // would split it into 5.
      const cells = dataRow!.split(/(?<!\\)\|/); // split on pipes NOT preceded by a backslash
      expect(cells).toHaveLength(6); // leading/trailing empty strings from the outer pipes + 4 cells
    });

    it('collapses a standalone "\\r" (not just "\\r\\n"/"\\n") to a space (self-review finding: CommonMark ' +
       'treats a lone \\r as a line ending too, which the old \\r?\\n pattern missed)', () => {
      const md = formatFeedbackSummaryMarkdown(resultWith('line one\rline two', 'Security', 'a-dev'));
      const dataRow = md.split('\n').find(l => l.startsWith('| line one'));
      expect(dataRow).toBeDefined();
      expect(dataRow).toContain('line one line two');
      expect(dataRow).not.toContain('\r');
    });

    it('escapes "|" in the severity field too (self-review finding: defense-in-depth, ' +
       'even though severity is enum-constrained by the Gemini schema on every path that produces it today)', () => {
      const result: FeedbackPassResult = {
        mode: 'observe', skipped: false, threadsScanned: 1, repliesClassified: 1, repliesAdjudicated: 0,
        findings: [{
          findingId: 'abc123def4567890', threadUrls: ['https://github.com/x/y/pull/1#discussion_r1'],
          agent: 'Security', severity: 'HIGH|INJECTED', summary: 'fine',
          replies: [{ commentId: 2, author: 'a-dev', isBot: false, stance: 'accepted', confidence: 0.9, bodyExcerpt: 'ok' }],
        }],
      };
      const md = formatFeedbackSummaryMarkdown(result);
      expect(md).toContain('HIGH\\|INJECTED');
      expect(md).not.toContain('HIGH|INJECTED');
    });
  });

  describe('formatFeedbackSummaryMarkdown — Phase 2a dry-run rendering', () => {
    function respondResultWith(replies: any[]): FeedbackPassResult {
      return {
        mode: 'respond',
        skipped: false,
        threadsScanned: 1,
        repliesClassified: replies.length,
        repliesAdjudicated: replies.filter(r => r.adjudication).length,
        findings: [{
          findingId: 'abc123def4567890',
          threadUrls: ['https://github.com/x/y/pull/1#discussion_r1'],
          agent: 'Logic', severity: 'HIGH', summary: 'some finding',
          replies,
        }],
      };
    }

    it('always shows the dry-run banner for mode "respond", even with nothing to show', () => {
      const md = formatFeedbackSummaryMarkdown(respondResultWith([]));
      expect(md).toContain('Dry run');
      expect(md).toContain('nothing below was sent to GitHub');
    });

    it('never shows the dry-run banner for mode "observe"', () => {
      const md = formatFeedbackSummaryMarkdown({
        mode: 'observe', skipped: false, threadsScanned: 0, repliesClassified: 0, repliesAdjudicated: 0, findings: [],
      });
      expect(md).not.toContain('Dry run');
    });

    it('renders the full (untruncated) rebuttal text for a would-post decision, not a shortened preview', () => {
      const rebuttal = 'This is the full rebuttal argument GSR would post, in full.';
      const md = formatFeedbackSummaryMarkdown(respondResultWith([{
        commentId: 2, author: 'a-dev', isBot: false, stance: 'rejected', confidence: 0.8, bodyExcerpt: 'disagree',
        adjudication: { verdict: 'pushback_incorrect', confidence: 0.9, reasoning: 'stands', rebuttalMarkdown: rebuttal, wouldPost: true },
      }]));
      expect(md).toContain('Would post (1)');
      expect(md).toContain(rebuttal);
    });

    // CodeRabbit finding (this PR's own /security-review pass flagged the
    // same gap but initially left it as documented residual risk — wrong
    // call, since a misleading Job Summary undermines the human-review gate
    // Phase 2a exists to provide): a rebuttal or finding summary containing
    // a literal `</details>` must not be able to prematurely close the
    // disclosure block or otherwise break the rendered structure.
    it('neutralizes a literal </details> in the rebuttal so it cannot break out of the <details> block ' +
       '(narrow tag-boundary escaping — see escapeMarkdownUnsafeTags — not blanket HTML-entity escaping: ' +
       'only "<" immediately before a tag-starting character is touched, so ">" stays literal)', () => {
      const md = formatFeedbackSummaryMarkdown(respondResultWith([{
        commentId: 2, author: 'a-dev', isBot: false, stance: 'rejected', confidence: 0.8, bodyExcerpt: 'disagree',
        adjudication: {
          verdict: 'pushback_incorrect', confidence: 0.9, reasoning: 'stands',
          rebuttalMarkdown: 'still applies</details><script>alert(1)</script>', wouldPost: true,
        },
      }]));
      expect(md).not.toContain('</details><script>');
      expect(md).toContain('&lt;/details>');
      expect(md).toContain('&lt;script>');
      // Exactly one real </details> closing tag: the one this function
      // itself appends to close the block — the injected one is neutralized.
      expect((md.match(/<\/details>/g) || []).length).toBe(1);
    });

    it('leaves a legitimate "<" comparison operator inside inline code untouched (the readability cost ' +
       'blanket escaping would have had — CodeRabbit finding, corrected)', () => {
      const md = formatFeedbackSummaryMarkdown(respondResultWith([{
        commentId: 2, author: 'a-dev', isBot: false, stance: 'rejected', confidence: 0.8, bodyExcerpt: 'disagree',
        adjudication: {
          verdict: 'pushback_incorrect', confidence: 0.9, reasoning: 'stands',
          rebuttalMarkdown: 'The check `x < 5` is still wrong here.', wouldPost: true,
        },
      }]));
      expect(md).toContain('`x < 5`');
    });

    it('leaves a blockquote-style ">" at the start of a line untouched', () => {
      const md = formatFeedbackSummaryMarkdown(respondResultWith([{
        commentId: 2, author: 'a-dev', isBot: false, stance: 'rejected', confidence: 0.8, bodyExcerpt: 'disagree',
        adjudication: {
          verdict: 'pushback_incorrect', confidence: 0.9, reasoning: 'stands',
          rebuttalMarkdown: '> quoting the original finding here', wouldPost: true,
        },
      }]));
      expect(md).toContain('> quoting the original finding here');
    });

    it('HTML-escapes a literal </summary> or angle brackets in the finding summary / author fields, within the ' +
       'new <details> section this PR adds (the pre-existing Phase 1 table row is a separate, out-of-scope gap ' +
       'not touched by this fix — scoping the assertion to the "Would post" section specifically)', () => {
      const md = formatFeedbackSummaryMarkdown({
        mode: 'respond', skipped: false, threadsScanned: 1, repliesClassified: 1, repliesAdjudicated: 1,
        findings: [{
          findingId: 'abc123def4567890', threadUrls: ['https://github.com/x/y/pull/1#discussion_r1'],
          agent: 'Logic', severity: 'HIGH', summary: 'finding</summary><img src=x onerror=alert(1)>',
          replies: [{
            commentId: 2, author: '<img src=x>', isBot: false, stance: 'rejected', confidence: 0.8, bodyExcerpt: 'disagree',
            adjudication: { verdict: 'pushback_incorrect', confidence: 0.9, reasoning: 'stands', rebuttalMarkdown: 'x', wouldPost: true },
          }],
        }],
      });
      const wouldPostSection = md.slice(md.indexOf('### Would post'));
      expect(wouldPostSection).not.toContain('</summary><img');
      expect(wouldPostSection).not.toContain('<img src=x>');
      expect(wouldPostSection).toContain('&lt;');
    });

    it('reports a suppressed pushback_incorrect verdict distinctly from a would-post one', () => {
      const md = formatFeedbackSummaryMarkdown(respondResultWith([{
        commentId: 2, author: 'a-dev', isBot: false, stance: 'rejected', confidence: 0.8, bodyExcerpt: 'disagree',
        adjudication: { verdict: 'pushback_incorrect', confidence: 0.9, reasoning: 'stands', rebuttalMarkdown: 'x', wouldPost: false, suppressedReason: 'per-run-cap' },
      }]));
      expect(md).not.toContain('Would post (1)');
      expect(md).toContain('1 additional');
      expect(md).toContain('suppressed');
    });

    it('does not surface a merely-not-eligible verdict (below confidence, or pushback_correct/unclear) as "suppressed"', () => {
      const md = formatFeedbackSummaryMarkdown(respondResultWith([{
        commentId: 2, author: 'a-dev', isBot: false, stance: 'rejected', confidence: 0.8, bodyExcerpt: 'disagree',
        adjudication: { verdict: 'pushback_correct', confidence: 0.9, reasoning: 'developer was right', rebuttalMarkdown: '', wouldPost: false },
      }]));
      expect(md).not.toContain('Would post');
      expect(md).not.toContain('suppressed');
    });
  });
});
