// Phase 4 repost-suppression (review-quality-design.md §2.1, and the
// §2.1 addendum's "Repost-suppression itself ... a separate follow-up PR"
// instruction, now that PR #68 stabilized the v2 `findingId`). Decides, for
// each finding the orchestrator produced this run, whether to post it as a
// new inline PR comment, suppress it silently, or collapse it into the
// review summary's one-line "remain unaddressed" mention — using nothing
// but the v2 `findingId` plus a per-file diff content hash, both
// round-tripped through the marker on GSR's own prior comments
// (github.ts's listReviewThreads). No separate persistence: the PR thread
// itself is still the only system of record (findingMarker.ts's module
// doc).
//
// --- The two kinds of "same finding, seen before" ---
//
// The design doc's addendum left this distinction unresolved ("Work out and
// document this explicitly; don't leave it implicit") — resolved here:
//
// 1. UNCHANGED: a prior GSR comment already carries this exact findingId,
//    and the file's diff content hash matches what was recorded when that
//    comment was posted. Nothing about that file's diff has changed since
//    GSR last said this — exactly the PR #17 WriteHeader case (7 identical
//    reposts across pushes that touched OTHER files, not the flagged one).
//    Suppressed permanently and silently: no new comment, no state mutation
//    anywhere (the existing comment already says everything there is to
//    say, and is still visible on the PR). This bucket never grows a repost
//    count — since it never posts again, there's no runaway-noise risk for
//    a counter to guard against.
//
// 2. CHANGED-BUT-RECURRING: a prior GSR comment carries this findingId, but
//    the file's diff content hash has changed — something in this file's
//    diff moved since the last post. Per the design doc, this gets NO
//    special suppression on its own ("let normal diff-driven re-review
//    behavior handle it, no special case") — if Gemini still emits the same
//    finding, that is a legitimate re-raise (still broken, or a new
//    instance of the same class of issue). But an author who keeps
//    editing the file without ever fixing the underlying issue would
//    otherwise regenerate a fresh, full-body comment every push forever.
//    REPOST_THRESHOLD bounds that: once a finding has already been posted
//    REPOST_THRESHOLD times, a further "still recurring" instance collapses
//    into one summary line instead of another full comment.
//
// A finding's content hash is a per-FILE approximation, not per-line — see
// findingMarker.ts's computeContentHash for why (only a unified diff patch
// is available, not full-file content) and why that bias is safe in only
// one direction (can over-count as "changed", never wrongly suppress a
// finding whose flagged code actually changed).

import { CandidateFinding, DiffChunk, FindingThread } from './types';
import { computeContentHash } from './findingMarker';

export const REPOST_THRESHOLD = 3;

export interface MarkerOverride {
  contentHash: string;
  repostCount: number;
}

export interface RepostPlan {
  toPost: CandidateFinding[];
  collapsedCount: number;
  markerOverrides: Map<string, MarkerOverride>;
}

function hashForFile(file: string, currentDiff: DiffChunk[]): string {
  const chunk = currentDiff.find(c => c.file === file);
  return computeContentHash(chunk?.content ?? '');
}

// Only threads carrying a v2 marker's `h=`/`n=` fields are meaningful input
// here — a v1-marker or legacy pre-marker thread has neither field, and per
// review-quality-design.md §2.1 addendum's "no retroactive linkage"
// decision its findingId uses a different hash formula than any id a fresh
// (always-v2) finding computes, so it can never collide with one anyway.
// When two prior threads share one findingId (should be rare — a
// concurrent-run race, or the CHANGED-BUT-RECURRING path itself posting the
// same id more than once across pushes), the one with the higher
// repostCount is authoritative, mirroring github.ts's deriveGsrLastReply
// max-of-independent-fields approach for the same "don't let a stale
// duplicate un-suppress state a newer thread already advanced" reason.
//
// CodeRabbit finding (PR #69): on an exact repostCount tie, `>=` (not `>`)
// keeps the LATER-encountered thread, not the first. `priorThreads` comes
// from listReviewThreads, which returns threads in roughly ascending
// root-creation order (comments are fetched sorted 'created'/'asc' and
// grouped by first-seen root) — so on a tie, the later entry is the more
// recently posted one. Two racing runs that happened to both compute the
// same repostCount from different diffs would otherwise let the older
// (possibly stale) contentHash win, which could force an unnecessary
// repost of a finding whose newer post already reflects the current diff.
function latestPriorByFindingId(priorThreads: FindingThread[]): Map<string, MarkerOverride> {
  const map = new Map<string, MarkerOverride>();
  for (const t of priorThreads) {
    if (t.contentHash === undefined || t.repostCount === undefined) continue;
    const existing = map.get(t.findingId);
    if (!existing || t.repostCount >= existing.repostCount) {
      map.set(t.findingId, { contentHash: t.contentHash, repostCount: t.repostCount });
    }
  }
  return map;
}

// planRepost is pure — no GitHub/network access — so it's the same function
// both action-entrypoint.ts's real run and the multi-push simulation test
// (§7.2) exercise directly.
export function planRepost(
  newFindings: CandidateFinding[],
  priorThreads: FindingThread[],
  currentDiff: DiffChunk[],
): RepostPlan {
  const priorById = latestPriorByFindingId(priorThreads);
  const toPost: CandidateFinding[] = [];
  const markerOverrides = new Map<string, MarkerOverride>();
  let collapsedCount = 0;

  for (const finding of newFindings) {
    const id = finding.id;
    if (!id) {
      // Defensive: orchestrator.ts always sets `.id` (via computeFindingId)
      // before findings reach here. Treat a missing id as unseen rather
      // than throwing — posting once too often is a far safer failure mode
      // than silently dropping a real finding.
      toPost.push(finding);
      continue;
    }

    const newHash = hashForFile(finding.file, currentDiff);
    const prior = priorById.get(id);

    if (!prior) {
      toPost.push(finding);
      markerOverrides.set(id, { contentHash: newHash, repostCount: 1 });
      continue;
    }

    if (prior.contentHash === newHash) {
      continue; // UNCHANGED — silently suppressed, see module doc above
    }

    if (prior.repostCount >= REPOST_THRESHOLD) {
      collapsedCount++;
      continue; // CHANGED-BUT-RECURRING, over threshold — collapse
    }

    toPost.push(finding);
    markerOverrides.set(id, { contentHash: newHash, repostCount: prior.repostCount + 1 });
  }

  return { toPost, collapsedCount, markerOverrides };
}
