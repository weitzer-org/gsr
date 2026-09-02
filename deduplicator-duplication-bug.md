# Deduplicator "duplication" bug — collapse and passthrough

Status: **known, not fixed.** Discovered as a side effect of the Gemini
model-comparison investigation (see `gemini-flash-model-investigation.md`).
Real, pre-existing production behavior, independent of which Gemini model is
used for discovery/remediation — tracked here for a dedicated follow-up fix,
deliberately out of scope for the fixes shipped in PR #74.

## 1. Problem

`DeduplicatorAgent.deduplicate()` (`adk/backend/src/deduplicator.ts`) takes
the swarm's raw candidate findings and asks Gemini to merge overlapping ones
into a single deduplicated list. In practice it has **two opposite failure
modes**, both of which corrupt the finding count GSR reports — one silently
destroys real findings, the other silently fabricates extra ones.

```
allFindings = subagentFindingsWithSource.concat(basicFindingsWithSource)
```
(`app.ts`) is the only place the two channels combine — the subagent swarm
goes through `deduplicate()` when `USE_DEDUPLICATOR !== 'false'`, the
"Basic" single-agent control never does (`useDedup: false`). That
Basic/dedup split is what made both failure modes visible at all: comparing
the same review's subagent-and-deduped count against its dedup-immune Basic
count exposed swings the actionability/recall metrics alone did not explain.

## 2. Failure mode A: collapse (dominant on large PRs)

Given a large, healthy set of candidate findings (e.g. 34 real, distinct
findings from a multi-file PR), the deduplication model sometimes merges
them down to 1-2 findings — not because they were duplicates, but because
the model appears to over-aggressively generalize "these are all in the same
file/pattern" into a single merged finding, discarding the rest.

This was the dominant confound in the focus-window batching experiment: the
batching change didn't make the underlying review better, it just changed
how many findings were exposed to a single dedup call, which changed how
often collapse triggered. Once collapse-affected runs were excluded from the
recall-based analysis, the measured batching effect became statistically
indistinguishable from noise (see the investigation doc §4 #6).

**Where to look:** `deduplicator.ts`'s dedup system instruction (the merge
criteria it gives the model) and its `responseSchema` don't constrain output
count relative to input count — the model is free to return arbitrarily few
findings with no signal to the caller that this happened. `app.ts` accepts
whatever `deduplicate()` returns.

## 3. Failure mode B: passthrough (dominant on small PRs, asymmetric by model)

`deduplicate()`'s outer `catch` block:

```ts
} catch (e) {
  console.error("[Deduplicator] Failed to deduplicate findings:", e);
  return findings;
}
```

falls back to returning the **raw, unmerged** input findings whenever the
dedup call itself errors (timeout, malformed response, API error). This is a
reasonable fail-open default in isolation — better to show duplicate
findings than to show none — but it means every dedup failure silently
inflates the reported finding count via duplication, with no distinction in
the UI or in stored results between "these are the deduplicated findings"
and "dedup failed, these are duplicates."

**This occurred asymmetrically by model** during the investigation: across
the small-PR benchmark set, the flash-tier candidate arm hit this fallback
7 times out of 30 reviews; the `gemini-3.1-pro-preview` baseline arm hit it
0 times out of 29. This asymmetry, before it was understood, was
misread as a signal about review quality — it's actually a signal that the
flash arm was producing candidate-finding shapes (likely more repetitive/
near-duplicate findings, see the `thinkingConfig` fix in
`deduplicator.ts` for a related but distinct cause) that triggered dedup
failures more often, which the passthrough fallback then converted into
inflated finding counts, not degraded ones.

## 4. Why both matter together

These two modes push finding counts in opposite directions (collapse: too
few; passthrough: too many) and dominate in different regimes (collapse on
large PRs, passthrough on small ones), which is part of why they went
undetected for as long as they did — neither one alone produces a
consistent bias that a single aggregate metric would flag, and the
Basic-channel cross-check that eventually surfaced them was largely
incidental to this investigation's original goal.

Any future measurement of GSR's review quality (this investigation, an eval
harness run, or a manual comparison) that trusts the subagent-and-deduped
finding count at face value, without also checking the dedup-immune Basic
channel or auditing for passthrough/collapse markers, risks reproducing the
same corrupted conclusions this investigation repeatedly ran into.

## 5. Suggested follow-up (not implemented here)

- Make dedup failures **visible** instead of silently falling back to raw
  passthrough: tag the response (e.g. `dedupFailed: true` alongside the
  findings) so callers and stored results can distinguish "genuinely this
  many findings" from "dedup broke, these are unmerged."
- Add a sanity check on the dedup model's own output: if `output.length <<
  input.length` for a large input (e.g. output is less than ~20% of input
  with no obvious file/pattern justification), treat it as a likely
  collapse and either retry, fall back to raw findings (with the same
  visibility tag as passthrough), or flag for review — the deduplicator has
  no such check today.
- Audit whether `DEDUPLICATOR_MODEL` was ever pinned separately from
  `GEMINI_MODEL` during any of this investigation's experiments — if not,
  every "flash arm" measurement may have actually been a flash-discovery +
  pro-deduplicator hybrid, which would need to be corrected for before this
  bug's true model-dependence (if any) can be assessed.
- **Verify `thinkingConfig: { thinkingBudget: 4096 }` (added in PR #74) is
  safe for whatever model `DEDUPLICATOR_MODEL` actually resolves to.** Flagged
  by CodeRabbit's post-merge review of #74: this is hardcoded regardless of
  which model runs, and if an operator ever points `DEDUPLICATOR_MODEL` at a
  model that doesn't support `thinkingConfig`, the call could fail outright
  (worse than the original hang it was fixing) instead of degrading
  gracefully. Left unfixed rather than guessed at — this project's own
  verification-discipline rule is not to act on an unverified premise about
  external API behavior, and confirming which Gemini models reject
  `thinkingConfig` needs a live check against each candidate model, not an
  assumption. In practice `DEDUPLICATOR_MODEL` has (per the audit item above)
  likely never been set away from the default, so the exposure may be
  theoretical today — but should be closed before anyone changes it.
- **CodeRabbit's post-merge review of #74 also suggested re-adding a
  process-wide semaphore/lock around `deduplicate()`.** Declined: PR #74
  had just *removed* exactly that lock as a validated fix (it was
  serializing every concurrent dedup call server-wide; removing it took a
  batch from 0/3 to 5/6 success — see the deduplicator reliability commit in
  #74). A bot review has no access to that measurement and re-adding the
  lock would silently reintroduce the regression it fixed. Recorded here so
  a future reviewer doesn't re-suggest it without first checking this
  history.
