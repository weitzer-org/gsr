import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { runFeedbackPass, formatFeedbackSummaryMarkdown, FeedbackPassResult } from '../src/feedbackLoop';
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
    process.env = originalEnv;
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

  it('mode "respond" degrades to observe-only (no posting) and still classifies', async () => {
    const t = thread({
      replies: [{ commentId: 2, author: 'a-developer', isBot: false, createdAt: 't', body: 'fixed it' }],
    });
    const gh = mockGh([t]);
    jest.spyOn(AdjudicatorAgent.prototype, 'classifyReplies').mockResolvedValue([
      { commentId: 2, stance: 'accepted', confidence: 0.9 },
    ]);
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await runFeedbackPass(gh, 'https://github.com/x/y/pull/1', { mode: 'respond' });

    expect(result.mode).toBe('respond');
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].replies[0].stance).toBe('accepted');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('respond'));
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
      expect(result.findings[0].replies.map(r => r.commentId).sort()).toEqual([10, 11]);
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
  });

  describe('formatFeedbackSummaryMarkdown (quick-review finding: pipe-escaping)', () => {
    function resultWith(summary: string, agent: string, author: string): FeedbackPassResult {
      return {
        mode: 'observe',
        skipped: false,
        threadsScanned: 1,
        repliesClassified: 1,
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

    it('escapes "|" in the severity field too (self-review finding: defense-in-depth, ' +
       'even though severity is enum-constrained by the Gemini schema on every path that produces it today)', () => {
      const result: FeedbackPassResult = {
        mode: 'observe', skipped: false, threadsScanned: 1, repliesClassified: 1,
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
});
