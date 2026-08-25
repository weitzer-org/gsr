import { describe, it, expect } from '@jest/globals';
import { planRepost, REPOST_THRESHOLD } from '../src/repostSuppression';
import { computeContentHash } from '../src/findingMarker';
import { CandidateFinding, DiffChunk, FindingThread } from '../src/types';

const DIFF_A = '@@ -1,3 +1,3 @@\n-old\n+new';
const DIFF_A_HASH = computeContentHash(DIFF_A);
const DIFF_B = '@@ -1,3 +1,3 @@\n-old\n+different';
const DIFF_B_HASH = computeContentHash(DIFF_B);

function finding(overrides: Partial<CandidateFinding> = {}): CandidateFinding {
  return {
    file: 'app.py',
    line: 42,
    severity: 'HIGH',
    summary: 'summary',
    description: 'description',
    agent: 'Security',
    id: 'finding-id-1',
    ...overrides,
  };
}

function priorThread(overrides: Partial<FindingThread> = {}): FindingThread {
  return {
    rootCommentId: 1,
    htmlUrl: 'https://github.com/org/repo/pull/1#discussion_r1',
    findingId: 'finding-id-1',
    contentHash: DIFF_A_HASH,
    repostCount: 1,
    replies: [],
    ...overrides,
  };
}

const chunksWithHashA: DiffChunk[] = [{ file: 'app.py', content: DIFF_A }];
const chunksWithHashB: DiffChunk[] = [{ file: 'app.py', content: DIFF_B }];

describe('planRepost — new finding, never posted before', () => {
  it('posts it, with repostCount 1 and the current content hash', () => {
    const plan = planRepost([finding()], [], chunksWithHashA);
    expect(plan.toPost).toHaveLength(1);
    expect(plan.collapsedCount).toBe(0);
    expect(plan.markerOverrides.get('finding-id-1')).toEqual({ contentHash: DIFF_A_HASH, repostCount: 1 });
  });

  it('a missing finding.id (defensive — orchestrator.ts always sets it) is treated as unseen, not dropped', () => {
    const plan = planRepost([finding({ id: undefined })], [], chunksWithHashA);
    expect(plan.toPost).toHaveLength(1);
  });
});

describe('planRepost — UNCHANGED (same id, same file diff content hash)', () => {
  it('suppresses the repost entirely — this is the PR #17 WriteHeader case', () => {
    const plan = planRepost([finding()], [priorThread({ contentHash: DIFF_A_HASH, repostCount: 1 })], chunksWithHashA);
    expect(plan.toPost).toHaveLength(0);
    expect(plan.collapsedCount).toBe(0);
    expect(plan.markerOverrides.size).toBe(0);
  });

  it('stays suppressed across many consecutive unchanged runs (no runaway collapse-counting for this bucket)', () => {
    const prior = priorThread({ contentHash: DIFF_A_HASH, repostCount: 1 });
    for (let i = 0; i < 10; i++) {
      const plan = planRepost([finding()], [prior], chunksWithHashA);
      expect(plan.toPost).toHaveLength(0);
      expect(plan.collapsedCount).toBe(0);
    }
  });

  it('an unrelated file elsewhere in the diff changing does not break suppression', () => {
    const chunks: DiffChunk[] = [...chunksWithHashA, { file: 'other.py', content: 'unrelated change' }];
    const plan = planRepost([finding()], [priorThread({ contentHash: DIFF_A_HASH, repostCount: 1 })], chunks);
    expect(plan.toPost).toHaveLength(0);
  });
});

describe('planRepost — CHANGED-BUT-RECURRING (same id, file diff content hash differs)', () => {
  it('posts again (under threshold), incrementing repostCount and recording the new hash', () => {
    const plan = planRepost([finding()], [priorThread({ contentHash: DIFF_A_HASH, repostCount: 1 })], chunksWithHashB);
    expect(plan.toPost).toHaveLength(1);
    expect(plan.collapsedCount).toBe(0);
    expect(plan.markerOverrides.get('finding-id-1')).toEqual({ contentHash: DIFF_B_HASH, repostCount: 2 });
  });

  it(`collapses into the summary instead of a full repost once repostCount reaches REPOST_THRESHOLD (${REPOST_THRESHOLD})`, () => {
    const plan = planRepost(
      [finding()],
      [priorThread({ contentHash: DIFF_A_HASH, repostCount: REPOST_THRESHOLD })],
      chunksWithHashB,
    );
    expect(plan.toPost).toHaveLength(0);
    expect(plan.collapsedCount).toBe(1);
    expect(plan.markerOverrides.size).toBe(0);
  });

  it('a prior thread with no contentHash/repostCount signal (v1 marker or legacy thread) is ignored — ' +
     'the finding is treated as new, per the §2.1 addendum\'s "no retroactive linkage" decision', () => {
    const v1Thread: FindingThread = {
      rootCommentId: 1,
      htmlUrl: 'https://github.com/org/repo/pull/1#discussion_r1',
      findingId: 'finding-id-1', // same string, but this could never actually happen for a v1 vs v2 id in practice
      replies: [],
      // contentHash/repostCount both absent, as any real v1/legacy thread would be
    };
    const plan = planRepost([finding()], [v1Thread], chunksWithHashA);
    expect(plan.toPost).toHaveLength(1);
    expect(plan.markerOverrides.get('finding-id-1')).toEqual({ contentHash: DIFF_A_HASH, repostCount: 1 });
  });
});

describe('planRepost — multiple prior threads sharing one findingId', () => {
  it('takes the thread with the higher repostCount as authoritative (mirrors deriveGsrLastReply\'s max-of-fields approach)', () => {
    const threads = [
      priorThread({ rootCommentId: 1, contentHash: DIFF_A_HASH, repostCount: 1 }),
      priorThread({ rootCommentId: 2, contentHash: DIFF_B_HASH, repostCount: 2 }),
    ];
    // The lower-repostCount thread's hash (A) would suppress; the higher one's hash (B) does not.
    // The higher repostCount must win, so a diff matching hash B is treated as "unchanged" against it.
    const plan = planRepost([finding()], threads, chunksWithHashB);
    expect(plan.toPost).toHaveLength(0);
  });
});

describe('planRepost — a mix of new, unchanged, changed-recurring, and collapsed findings in one run', () => {
  it('routes each finding independently (one file per finding, so each can have its own hash relationship ' +
     'to its own prior state — content hash is per-file, so mixing cases on ONE file in ONE run is not possible)', () => {
    const newFinding = finding({ id: 'new-id', file: 'new.py' });
    const unchangedFinding = finding({ id: 'unchanged-id', file: 'unchanged.py' });
    const recurringFinding = finding({ id: 'recurring-id', file: 'recurring.py' });
    const collapsedFinding = finding({ id: 'collapsed-id', file: 'collapsed.py' });

    const priorThreads: FindingThread[] = [
      priorThread({ findingId: 'unchanged-id', contentHash: computeContentHash('unchanged.py old patch'), repostCount: 1 }),
      priorThread({ findingId: 'recurring-id', contentHash: computeContentHash('recurring.py OLD patch'), repostCount: 1 }),
      priorThread({ findingId: 'collapsed-id', contentHash: computeContentHash('collapsed.py OLD patch'), repostCount: REPOST_THRESHOLD }),
    ];

    const chunks: DiffChunk[] = [
      { file: 'new.py', content: 'brand new patch' },
      { file: 'unchanged.py', content: 'unchanged.py old patch' }, // identical to the prior post's hash input
      { file: 'recurring.py', content: 'recurring.py NEW patch' }, // differs from the prior post's hash input
      { file: 'collapsed.py', content: 'collapsed.py NEW patch' }, // differs from the prior post's hash input
    ];

    const plan = planRepost([newFinding, unchangedFinding, recurringFinding, collapsedFinding], priorThreads, chunks);

    const postedIds = plan.toPost.map(f => f.id).sort();
    expect(postedIds).toEqual(['new-id', 'recurring-id']);
    expect(plan.collapsedCount).toBe(1); // collapsed-id
    // unchanged-id is silently dropped — neither posted nor counted as collapsed.
    expect(plan.markerOverrides.get('recurring-id')?.repostCount).toBe(2);
  });
});
