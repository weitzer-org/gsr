# Gemini flash-model upgrade investigation — retrospective

Written for a fresh session picking this back up. This document is the
handoff: what was tried, what broke, what survived scrutiny, and — most
importantly — the specific methodology mistakes a next attempt should not
repeat. Read this before re-running any comparison, not after.

## 1. The question

Should GSR switch `GEMINI_MODEL` (currently `gemini-3.1-pro-preview`) to a
cheaper flash-tier model — `gemini-3.7-flash`, `gemini-3.6-flash`, or
`gemini-3.5-flash` — for discovery/remediation? Flash-tier pricing is
roughly 3-6x cheaper per token (see `usage.ts`'s `PRICE_TABLE`), so the
incentive is real if quality holds.

**3.5-flash and 3.6-flash are on Google's deprecation path — don't invest
further effort there.** If a next attempt is worthwhile, it's about
3.7-flash (or whatever superseding flash-tier model exists by the time this
is read) specifically.

## 2. Final verdict

**No candidate flash model is at genuine quality parity with
`gemini-3.1-pro-preview` on large, complex PRs.** This conclusion survived
four separate rounds of increasingly skeptical Opus-subagent verification,
each of which found a real methodology bug in the round before it, and it
still held after every bug was fixed. Treat it as solid.

The dominant, most trustworthy signal is a **deterministic finding-volume /
recall collapse on large PRs** — flash-tier candidates recovered roughly
28-31% of the baseline's findings on the 3 large real-world PRs in the
benchmark (`#50`, `#57`, `#58` from this repo), a gap far too large to be
noise. This is a more reliable signal than the LLM-judged actionability
score, because actionability only rates the quality of what a model *did*
report — a model that goes silent on most of a 15-file PR still scores fine
on actionability for its (small, correct) output. The judge cannot detect
"went quiet"; a deterministic recall metric can.

Two proposed mitigations were investigated and **both rejected**:

- **Size-based model routing** (route large PRs to `gemini-3.1-pro-preview`,
  everything else to a flash model) — mechanically validated to work (21/23
  discovery calls correctly routed in testing), but its entire justification
  rested on a "small-PR parity" claim that did not survive the same scrutiny
  applied to the large-PR data (see §4, round 4). The real small-PR recall
  gap is ~87.8% for 3.7-flash, not the ~100% originally reported.
- **Focus-window discovery batching** (split large PRs into smaller
  discovery windows, each still given the full diff for context but scoped
  to report on a subset of files) — measured effect (0.91x, p=0.81) is
  statistically indistinguishable from zero once dedup-collapse-contaminated
  runs are excluded from the comparison, and it may have increased
  concurrent API load enough to worsen the *baseline* arm's own dedup-
  timeout rate (64% vs 0% observed) as a side effect.

**What did ship** (PR #74, out of this investigation): two real dedup
reliability bugs, a broken persona-prompt template, usage-analytics
observability improvements, and several eval-harness measurement fixes. None
of it involves switching models, routing, or batching. See §7.

## 3. Setup: benchmark, metrics, replicate design

- **Benchmark**: 13 PRs. 10 small, single-seeded-bug PRs from an external
  fork (`gemini-cli-fork`) designed so "did it find the bug" is nearly
  binary, plus 3 large, real multi-file PRs from this repo (`#50`, `#57`,
  `#58`) chosen to stress cross-file reasoning and volume.
- **Runs**: R0 = baseline vs itself (`gemini-3.1-pro-preview` vs itself —
  establishes the noise floor). R1/R2/R3 = `gemini-3.7/3.6/3.5-flash` vs
  baseline. Later, a 3-replicate re-run of R0-R3 was done to get a sense of
  run-to-run variance.
- **Primary metric (LLM-judged)**: `tools/eval/llm-comparator-v2.ts` asks
  `gemini-2.5-pro` to score actionability/false-positives/unique-findings
  for both targets plus two third-party bots (Gemini Code Assist,
  CodeRabbit) on the same PR.
- **Secondary metric (deterministic, added mid-investigation)**:
  `computeRecall` in `tools/eval/validation.ts` — proximity-matches (same
  file, within 10 lines) a candidate's findings against a reference's
  findings, entirely independent of the judge. Added specifically because
  the actionability score cannot detect a model that goes silent on a large
  PR. **This ended up being the metric that mattered most** — most of the
  investigation's false leads trace back to trusting the judged score before
  this existed, or before it was itself debugged (see §4).

## 4. The methodology bugs, in the order they were found

This is the part most worth internalizing. **Every one of these was found
by treating a "positive" result with suspicion and asking an Opus subagent
to independently verify it, not by anyone anticipating the bug in advance.**
The pattern repeated four times: a result looked good → verification found a
measurement bug → fixing the bug reversed or shrank the result → repeat.

1. **Pooled-aggregation bug (mine).** Early aggregate comparisons pooled
   results across runs with different PR-set sizes, silently weighting some
   PRs more than others. Fixed by aggregating within a fixed, consistent PR
   set per comparison.
2. **Judge JSON key-naming mismatch.** The judge prompt asked for scores
   under display labels (e.g. `"Local"`/`"Production"`) instead of the
   literal `targetA`/`targetB` keys the code expected, so
   `r.v2Metrics['targetA']?.actionability || 0` silently read `undefined` as
   zero for whichever run used non-canonical keys. Fixed by (a) tightening
   the prompt to demand literal `targetA`/`targetB` keys regardless of
   display label, and (b) adding `normalizeV2Metrics` as a defensive
   fallback for whatever still comes back non-canonical.
3. **Judge score-transcription bug.** A subtler version of #2: the judge
   used the *correct* keys but swapped the *values* — one observed case
   scored `targetA` (which was actually "Local", the weaker output that
   round) 10/10 with 9 unique findings, while the prose report praised
   "Production" (the stronger output) at length. Caught via a
   `metricsPlausible` guard: flag a result implausible whenever
   `uniqueFindings` for a target exceeds how many findings that target
   actually submitted. Not fixable at the source (it's the judge model
   making a mistake); the fix is to detect and exclude, not correct.
4. **Judge position bias.** Whichever target was presented first / labeled
   with the more prominent name (e.g. "Local" before "Production") scored
   measurably higher, independent of actual quality — visible in R0
   (baseline vs itself, where any consistent difference is pure bias, not
   signal). Fixed by randomizing, per PR, which target the judge sees as
   `targetA`/`targetB`, then un-swapping the returned metrics before storage
   so every downstream consumer can keep treating `targetA`/`targetB` as
   stable structural labels.
5. **Retry-selection bias (one direction).** Before an in-run retry existed,
   failed PR attempts were retried manually and ad hoc — whichever attempt
   happened to survive got kept, with no guarantee that was representative.
   Large/volatile PRs error more often, so this systematically
   under-represented degraded large-PR behavior. "Fixed" by adding
   `evaluate.ts`'s in-run auto-retry (retry the same PR up to
   `EVAL_MAX_PR_RETRIES` times within the same run until both targets
   succeed).
6. **Retry-selection bias (the opposite direction, introduced by #5's fix).**
   Auto-retry has its own new bias: a fast-but-broken result (e.g. the
   deduplicator's collapse failure mode, see
   `deduplicator-duplication-bug.md`) can complete within the client-side
   timeout and get accepted, while a slow-but-healthy result gets abandoned
   as a timeout and retried away. Net effect: auto-retry can preferentially
   *keep* broken-but-fast results over correct-but-slow ones. **This is not
   fully solved** — it's a real improvement over #5's fully-manual process,
   but not a complete fix. Flag this explicitly in any future analysis that
   uses `evaluate.ts`'s retry results.
7. **`computeRecall`'s non-1:1 matching.** The original implementation used
   `.some()` to check whether *any* candidate finding was near a reference
   finding — which let a single candidate finding "recover" multiple nearby
   reference findings, inflating recall most for exactly the candidates
   with very few findings scattered across a large file (i.e. exactly the
   flash-tier failure mode this metric exists to catch). Fixed with greedy
   1:1 matching (a `consumed` set of already-matched candidate indices).
   **This fix is what overturned the small-PR-parity claim underlying the
   routing recommendation** — real small-PR recall for 3.7-flash is ~87.8%,
   not ~100%.
8. **Known, still-unfixed landmine: `normalizeV2Metrics`'s fallback.** The
   fallback candidate-key list hardcodes `canonical === 'targetA' ? 'local'
   : 'production'` — it doesn't account for the per-PR slot-swap direction
   from fix #4. Under a swap, both `targetA` and `targetB` lookups can
   resolve to the same underlying object, fabricating a false tie. This
   shipped in PR #74 as-is (the primary key-matching path added in the same
   fix is correct and handles the common case; this fallback path is a
   secondary defense for malformed judge output specifically). **Fix this
   before trusting any future run's `normalizeV2Metrics`-recovered results
   under slot-swap.**
9. **This investigation's own cost-billing claim was itself unverified.**
   §7's original draft asserted `thoughtsTokenCount` was "previously silently
   free" and should be billed at the output rate, framing this as a fix. A
   concurrently-merged, unrelated PR (#73, a usage-metrics dashboard)
   independently added the same `thoughtsTokenCount` capture but explicitly
   chose **not** to fold it into cost — Gemini's pricing documentation
   describes the output rate as already including thinking tokens, and
   `candidatesTokenCount` may already reflect them for the models this
   project bills, so adding them again risks double-billing rather than
   correcting an undercount. That PR's reasoning is more carefully sourced
   than this investigation's was; PR #74 was rebased onto it and dropped its
   own billing change rather than defend an unverified assumption. **Any
   cost-per-model figures cited earlier in this investigation (§1's pricing
   comparison, any cost claims in older analysis) were computed without this
   correction and should be treated as approximate** — re-verify against
   current per-model API docs before relying on precise cost deltas.

Two additional, non-code-bug limitations, not "fixed" so much as flagged:

- **`computeRecall`'s proximity matching, even 1:1, still produces some
  false-positive matches** — round-4 verification found roughly 22-37%
  severity disagreement on matched pairs (i.e. two findings judged "the same
  issue" by proximity alone sometimes have wildly different severities,
  suggesting they're not actually the same issue). Treat all recall numbers
  from this investigation as an **optimistic upper bound**, not ground
  truth.
- **`DEDUPLICATOR_MODEL` was never audited or explicitly pinned** during any
  of these experiments. If it silently defaulted to `GEMINI_MODEL` in some
  runs and something else (or was left at a prior default) in others, some
  "flash arm" measurements could actually reflect a
  flash-discovery-plus-pro-deduplication hybrid rather than a pure flash
  pipeline. **Audit and explicitly pin this before the next comparison.**

## 5. Statistical power (a limitation on everything above)

Every conclusion in this investigation was drawn from **10 small PRs and 3
large PRs**. A back-of-envelope power calculation (permutation test on
log-ratios, stratified by PR, targeting an 80%-power detection of a 5-point
recall difference) suggests **55-65 PRs per arm** would be needed for real
confidence at that effect size. The large-PR recall gap (28-31% of
baseline) is big enough that 3 PRs was probably enough to detect *that it
exists*, but nothing in this investigation had the power to make fine-
grained claims (e.g. "3.7-flash is exactly at X% parity on PRs of size Y") —
those numbers should be read as directional, not precise. **If a next
investigation wants tighter numbers, budget for a much larger benchmark
before running comparisons, not after.**

## 6. What was tried to close the quality gap, and why each failed

1. **Prompt clarity fixes** (shipped, PR #74): the discovery/remediation
   persona prompts had a broken, never-substituted `{{FILE_PATH}}`/
   `{{DIFF_CONTENT}}` template appended after the real instructions — a
   clear, model-agnostic bug, unrelated to which model is used. Fixed
   regardless of the model question.
2. **Discovery-prompt COVERAGE/RECALL content change** (not shipped):
   diagnostic evidence pointed at Pass 1 (discovery) as the primary source
   of under-reporting on flash-tier models — they converted far fewer
   discovery calls into any remediation call at all (~42-43% vs baseline's
   ~67%), meaning they found nothing to report far more often, not just
   pruned more after the fact. Added explicit COVERAGE and "RECALL OVER
   PRECISION" language to push the discovery pass toward flagging more
   candidates. **Not shipped** because its measured benefit was entangled
   with the batching experiment's dedup-collapse contamination and never
   independently re-validated after that contamination was understood — if
   re-tried, isolate it as its own experiment, not bundled with batching.
3. **Focus-window discovery batching** (not shipped) — see §2.
4. **Size-based model routing** (not shipped) — see §2.

## 7. What actually shipped (PR #74)

- `deduplicator.ts` / `index.ts`: removed a process-wide dedup lock
  (unnecessary serialization of every concurrent dedup call), capped the
  dedup call's thinking budget at 4096 (root-caused a >5min hang on
  repetitive findings), raised Node's `requestTimeout` so the dedup-timeout
  fallback can reach the client.
- 10 persona prompt files: fixed the broken template (§6.1).
- `usage.ts` / `agent.ts`: capture `finishReason`, record JSON-parse
  failures as a visible, distinct failure mode instead of silently becoming
  `{ findings: [] }`, preserve accumulated token usage on failure paths.
  (`thoughtsTokenCount` capture/aggregation was added independently by a
  concurrently-merged, unrelated PR — see the correction in §4 #9 above;
  this investigation's own assumption about how to bill it was wrong.)
- `tools/eval/*`: the fixes from §4 (#2, #3, #4, #5, #6-partial, #7)
  — judge key-naming + `metricsPlausible`, 1:1 `computeRecall`, retry-until-
  complete, slot-swap randomization, NDJSON error/truncation propagation,
  errored-target aggregate exclusion.

Deliberately **not** shipped: the model switch, routing, batching, the
discovery-prompt content change, and the two known-remaining landmines
(`normalizeV2Metrics`'s fallback, #8; the deduplicator's duplication bug,
see `deduplicator-duplication-bug.md`).

## 8. Recommendations for a next attempt

1. **Start by auditing `DEDUPLICATOR_MODEL`** and reading
   `deduplicator-duplication-bug.md`. Both the collapse and passthrough
   dedup failure modes can silently corrupt any finding-count or recall
   measurement, and were the largest single source of confusion in this
   investigation once discovered. Consider running with `USE_DEDUPLICATOR=
   false` for a first-pass model comparison, using only the dedup-immune
   "Basic" channel, to get a cleaner initial read before reintroducing dedup
   noise.
2. **Fix the `normalizeV2Metrics` fallback landmine (§4 #8) before trusting
   any new run's slot-swapped, fallback-recovered metrics.**
3. **Budget for a much larger benchmark** (§5) if the goal is a precise
   parity number rather than a yes/no on "is there a large gap."
4. **Treat every "this looks positive" result as a bug report against your
   own measurement, not a finding, until an independent pass has tried to
   break it.** This was the single most valuable practice in this
   investigation — every positive-looking result that got this treatment
   turned out to be at least partly a measurement artifact.
5. **Isolate experiments.** The COVERAGE/RECALL prompt change and the
   batching change were run together, which made it impossible to credit
   either one individually once the combined result turned out to be
   contaminated. Run one variable at a time.
6. **`computeRecall` is a better primary signal than judged actionability**
   for this specific question (does a model silently under-report), but
   remember it's an optimistic upper bound (§4, false-positive-match note)
   — pair it with spot-checking matched pairs for genuine semantic
   agreement, not just proximity.
7. If 3.7-flash (or a successor) is retried, the most promising unexplored
   lever is the **COVERAGE/RECALL discovery-prompt change (§6.2), tested in
   isolation**, since the root cause it targets (discovery calls finding
   nothing to report, not remediation dropping findings after the fact) was
   never independently disproven — only never cleanly validated either.
