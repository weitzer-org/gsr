# Review Quality Improvements — Design

## 1. Background

A manual audit of `weitzer-org/job_tracker`'s 19 closed PRs (237 GSR findings)
found a 67.5% fix rate overall, but with a specific, actionable shape:
Security findings get fixed 91% of the time; Logic/Correctness findings — the
category most costly to miss — only 47%. Digging into *why* surfaced four
concrete, fixable gaps in GSR itself, not just prompt-wording nits. This doc
proposes changes for each, plus how to make `tools/eval` catch regressions
in this specific behavior going forward instead of relying on another manual
PR audit next time.

**Correction made mid-investigation, worth stating up front:** the original
read of this data assumed it reflected GSR's Architecture/Logic/Security/
TechDebt/Testing subagent swarm. It doesn't. `job_tracker`'s
`.github/workflows/gsr-review.yml` runs `mode: basic` on every PR (single
generic prompt, `adk/prompts/basic_prompt/basic.md`); the real swarm
(`gsr-review-deep.yml`, `mode: subagent`) only runs when a PR gets the
`deep-review` label — which never happened, across all 19 PRs. So **every
finding in this dataset came from the single "Basic" prompt persona; the
swarm has zero production data on this repo.** §5 addresses this directly —
it's arguably the highest-leverage gap of the four, because right now we're
tuning a product whose flagship feature has never actually been exercised in
its main consuming repo.

### 1.1 Would running the swarm (or a subset of it) have avoided these gaps?

Checked against the actual specialized prompts (`adk/prompts/system_prompts/
*.md`) and `orchestrator.ts`'s routing, not assumed — the answer differs by
gap, and one of them changes the fix proposed below:

| Gap | Would swarm mode have avoided it? |
|---|---|
| §2 repeated findings | **No.** Purely an `action-entrypoint.ts`/`github.ts` gap — nothing reads prior reviews before posting, in any mode. Swarm mode runs 6 unrestricted agents instead of 1, so it could plausibly make this **worse** (more independent sources re-raising the same unresolved issue each push). |
| §3 swarm has no data | N/A — running swarm is definitionally the fix. |
| §4 non-prod severity | **No, likely just as bad or worse.** None of the 10 specialized prompts have any "is this shipping code" awareness — `techdebt.md`, `architecture.md`, `testing.md`, `performance.md` all say "flag any diff matching my specialty," full stop. `shouldRun()` (`orchestrator.ts:114-125`) only path-restricts `cicd`/`dependencies`/`secrets`/`promptsecurity`; Architecture/Logic/Performance/TechDebt/Testing/Security run on every file unconditionally. A `design_prd/*.html` mockup would likely get hit by several of these agents independently instead of one Basic prompt. |
| §5 cross-file blindness | **Yes, likely — but the mechanism is narrower than originally stated.** See the revised root cause below; this one is a genuine correction, not just "swarm's prompts are smarter." |

The corrected §5 write-up below reflects this.

## 2. Gap 1 — no memory of a finding across re-review runs

**Evidence:** PR #17 received the identical HIGH "`WriteHeader` in `Write`
bypasses Content-Type sniffing" finding **7 times** across ~45 minutes as the
author pushed successive commits — including after the author had already
added a code comment explaining why the call is intentional. Each Action run
(`action-entrypoint.ts`) calls `ghClient.postReviewComments` with zero
awareness of what GSR itself said on this PR last time — `getPRDiff` fetches
the current diff, `postReviewComments` posts a fresh review
(`github.ts:95-149`); nothing reads prior `github-actions[bot]` reviews on
the PR first. `finding-feedback-requirements.md` independently identified
this same architectural gap ("Action-triggered reviews aren't persisted at
all," §4) while scoping a different feature (external feedback capture) —
this is the same missing piece, needed for a narrower, more urgent purpose.

**Why this matters beyond noise:** it's not just annoying — it actively
degrades trust in severity labels. A HIGH that's been re-raised 7 times
*reads* the same as a HIGH raised for the first time, so an author skimming
PR comments has no signal that "this one keeps coming back" should carry
more weight than "this is new," when arguably it should carry *less* (it's
already been considered and rejected) or a different kind of *more*
(escalate past a comment into a blocking check).

### 2.1 Decision: content-hash finding identity, consumed by the Action itself

Reuse `finding-feedback-requirements.md` §5.3's `findingId = sha256(file |
line | agent | summary)` scheme, but the *first* consumer is
`action-entrypoint.ts` itself, not an external feedback API:

1. Before posting, fetch the PR's existing review comments from
   `github-actions[bot]` (`GET /pulls/{pr}/comments`, filter by author — the
   same call the eval harness's `github-comments.ts` pattern already makes
   for third-party bots).
2. Compute `findingId` for each comment already on the PR (parse it back out
   of the rendered body, or — cleaner — embed it as an HTML comment marker
   in `formatFindingBody`, e.g. `<!-- gsr-finding:{id} -->`, invisible in
   the rendered comment but greppable on the next run).
3. Compute `findingId` for each new finding. Diff against the existing set:
   - **New id, not seen before** → post normally.
   - **Same id, comment still exists, flagged line's content is unchanged
     since last run** → **do not repost.** The finding is already visible on
     the PR; reposting adds nothing.
   - **Same id, flagged line's content changed** → the author touched it;
     re-run judgment implicitly happens because the finding either
     reappears (still broken) or doesn't (fixed) — normal diff-driven
     behavior, no special case needed.
4. Track a **repost count** invisibly (in the marker: `<!-- gsr-finding:{id}
   seen:3 -->`). After a threshold (e.g. 3 identical unresolved reviews),
   stop repeating the full finding body and collapse it to one line in the
   summary ("⏳ 4 finding(s) raised in prior reviews remain unaddressed — see
   above") rather than a wall of duplicate inline comments. This directly
   targets the PR #17 pattern without requiring GSR to understand *why* the
   author didn't act (the WriteHeader case was a reasoned rejection; GSR
   doesn't need to know that to stop repeating itself).

**Non-goal for this phase:** detecting *rejection* semantics (an author's
comment explaining why a finding doesn't apply). That requires reading
human-authored code comments and judging intent — real, but higher-risk and
better scoped later, once the finding-feedback mechanism exists and can
carry an explicit `verdict: "invalid"` from a human/agent rather than GSR
inferring it from silence.

## 3. Gap 2 — the subagent swarm has no production usage data

**Evidence:** §1. `deep-review` was never applied to any of 19 PRs. Every
number in the original audit — the 91%/47% category fix rates, the "Basic"
label everyone saw — describes one generic prompt's behavior, not the
Architecture/Logic/Security/TechDebt/Testing specialists this project is
actually built around.

**Why it happened:** `gsr-review-deep.yml`'s own comments explain the label
gate was a deliberate cost/latency tradeoff (mirrors CLAUDE.md's own
`/code-review` escalation ladder — cheap-by-default, opt-in for
architecturally risky changes). That's a reasonable policy. The problem is
purely that *nobody applies the label*, so the intended "opt-in for risky
changes" ends up meaning "opt-in never," and the swarm — the product's core
differentiator — ships with no real-world signal on whether it actually
outperforms the single prompt on the category (Logic/Correctness) that
matters most.

### 3.1 Decision: shadow-run the swarm, don't change the default gate

Don't flip `job_tracker`'s default to `mode: subagent` — that reintroduces
the cost/latency tradeoff the label gate exists to avoid, and it's not
GSR's call to make for a consuming repo anyway. Instead, close the data gap
without touching the PR-facing behavior:

- `action-entrypoint.ts` gets an optional `SHADOW_MODE=subagent` env var
  (repo-level Action input, off by default). When set, it runs the
  **non-posting** orchestrator (subagent swarm) alongside whichever mode is
  configured for posting, exactly like `app.ts:84-154` already does for the
  web UI's `subagentOrchestrator` vs `basicOrchestrator` comparison —
  `Evaluator` (`evaluator.ts`) already exists purpose-built for this
  comparison, it's just never wired into the Action path.
- Shadow results (both orchestrators' findings + the `Evaluator` comparison
  text) get logged as an Action step summary (`$GITHUB_STEP_SUMMARY`) —
  visible to whoever's curious, zero effect on the PR review itself, zero
  extra Gemini cost beyond running the second orchestrator.
- Turn this on for `job_tracker` (and ideally the other consuming repos) for
  a bounded window — enough PRs to get a real answer to "does the swarm
  actually beat Basic on Logic/Correctness recall" — then decide with data
  whether the label-gate threshold should change, not before.

This is deliberately cheap and reversible: it's turning on data collection
GSR already has 90% of the code for, not redesigning the mode-selection
policy up front.

## 4. Gap 3 — findings on non-shipping content reviewed at full severity

**Evidence:** ~19 of 25 "correctly ignored" findings were on static design
mockups (`design_prd/*.html` — historical reference artifacts, never served)
or one-off root-level debug scripts touched exactly once and referenced by
nothing. GSR flagged UI race conditions in the mockup and "test failures
swallowed"/"no healthcheck timeout" (HIGH) in scratch scripts — real
observations, applied to code that will never run in production, at the
same severity as `internal/*.go`.

**Root cause:** neither `basic.md` nor the subagent prompts
(`adk/prompts/system_prompts/`) have any notion of "this path is reference
material / scratch tooling, weight it down." `github.ts:getPRDiff`'s
`IGNORE_PATTERNS` (line 49-58) already does exactly this kind of path-based
filtering for lockfiles/minified bundles/`dist/`/`build/` — the mechanism
exists, it's just not extended to "low-value-to-review" as opposed to
"can't-meaningfully-review."

### 4.1 Decision: severity dampening, not exclusion, via a configurable path list

Exclusion (like `IGNORE_PATTERNS`) is wrong here — these files can contain
real issues (the mockup's bugs are real bugs, just low-stakes) — so skip
review entirely is too blunt. Instead:

- Add a `LOW_PRIORITY_PATH_PATTERNS` config (Action input `low-priority-paths`,
  comma-separated globs, with a sensible built-in default:
  `design_prd/**`, `**/*.mockup.html`, root-level one-off scripts matching
  common scratch-script naming). Consuming repos can extend/override the
  defaults for their own conventions (this mirrors `IGNORE_PATTERNS`'
  regex-array shape, just additive rather than exclusionary).
- In `orchestrator.ts`'s `filterFindings` (currently a flat severity floor,
  line 264-272), cap severity for findings whose `file` matches a
  low-priority pattern: CRITICAL/HIGH → MEDIUM, at most. This is a
  post-hoc dampening step, not a prompt change — keeps the subagents'
  actual analysis untouched and auditable, just changes what gets surfaced
  and how loudly.
- Every consuming repo already declares which paths are "real code" vs
  "reference/scratch" implicitly via its own conventions — this doesn't
  need to be smart/inferred, a config list is sufficient and matches this
  project's existing "config over inference" pattern (`shouldRun`'s
  `rules` map in `orchestrator.ts:114-119` is the same shape).

## 5. Gap 4 — file-by-file routing causes confidently wrong cross-file claims

**Evidence:** PR #15 got a Logic finding stating `applyConfig is called but
is not defined in this file` — false; it's defined in `cmd/eval/apply.go`, a
brand-new file **added in this same PR**, valid per Go's package-level
scoping. This isn't a severity-tuning nit, it's GSR being *wrong* about a
correctness claim, corrosive specifically for the category (Logic) most in
need of credibility (§1, 47% fix rate).

**Root cause (corrected):** the first version of this doc attributed this to
GSR only ever seeing diff hunks, never full files. That's not quite it —
checking PR #15's actual diff, `cmd/eval/apply.go`'s entire 62-line
definition (all `+` lines, a new file) **was** part of the PR's diff data
that `GitHubClient.getPRDiff` fetched. The real cause is narrower:
`action-entrypoint.ts`'s `MODE_CONFIG` maps `basic: { useDedup: false }`,
and that value is passed positionally into `Orchestrator`'s constructor as
`useTriage` (`orchestrator.ts:18`) — which, per the comment on
`orchestrator.ts:15`, now actually controls **aggregation**, not literally
triage. `useTriage=false` sends `runReview` down the legacy "file-by-file"
branch (`orchestrator.ts:188-224`): `agent.analyze([chunk])`, **one file per
call**. So the Basic-mode call reviewing `main.go` never had `apply.go`'s
diff in its prompt at all — not a missing-data problem, a missing-context-
window problem caused by how basic mode is wired. Subagent mode has
`useTriage=true` → the aggregated branch (`orchestrator.ts:140-187`) →
`agent.analyze(activeChunks)`, **all of an agent's files in one call** — a
swarm Logic agent reviewing this PR would have had `apply.go`'s new function
in the same prompt as `main.go`'s usage of it, and likely wouldn't have made
this claim (per §1.1).

This only resolves same-PR sibling-file cases, though. It does nothing for
a symbol defined in a file this PR doesn't touch at all — that's a genuinely
separate problem (see the out-of-scope note below), and aggregation can't
help there because the defining file was never part of the diff to begin
with, in any mode.

### 5.1 Decision: two tiers, cheap fix first

**Tier 1 — fix the routing, not the model.** The gap between "basic mode
reviews file-by-file" and "subagent mode reviews the whole PR aggregated
per agent" is an accidental side effect of `useDedup` and `useTriage` being
the same constructor parameter, not a deliberate design choice for basic
mode specifically (nothing in `action-entrypoint.ts` or `orchestrator.ts`'s
comments argues basic mode *should* lose cross-file visibility — it's a
naming collision). Decouple them: give `Orchestrator`'s constructor an
explicit `aggregateChunks: boolean` distinct from whether the deduplicator
runs, and have `action-entrypoint.ts`'s `MODE_CONFIG` set
`aggregateChunks: true` for **both** modes. This fixes the PR #15 class of
false claims for basic mode too, for free, without waiting on §3's
shadow-run decision — and it's a smaller, safer change than building new
fetch machinery.

**Tier 2 — on-demand full-file fetch, only for the genuinely out-of-diff
case.** For symbols defined in a file this PR doesn't touch, aggregation
can't help by construction. If this turns out to matter in practice (the
regression fixture in §7.1 will tell us), add a narrow fallback: in
`GeminiAgent`'s **Pass 2 (remediation)** step only (`buildRemediationPrompt`,
`agent.ts:303-315`, which already runs once per *discovered issue*, not once
per file, so the fan-out is bounded by finding count), detect discovery-
stage issues whose `summary` matches a small set of definition-shaped claim
patterns ("is not defined", "does not exist", "undefined", "no such
method/function") and fetch full content for the flagged file via a new
`GitHubClient.getFileContent(owner, repo, ref, path)` helper (thin wrapper
over `octokit.rest.repos.getContent`) before generating the remediation. Only
build this if Tier 1 alone doesn't clear the §7.1 fixture — it's the
costlier of the two and may turn out to be unnecessary.

**Related, explicitly out of scope for this doc:** the same UTF-8
byte-slicing bug was correctly flagged and fixed in
`internal/recruiter/apify.go` (PR #8) but an identical instance in
`internal/ingest/apify.go` (PR #1, five months earlier) was never
re-flagged, because GSR reviews diffs, not the whole repo, and has no
memory across PRs. Catching "this exact bug pattern exists elsewhere in the
repo, not just in this diff" is a full-repo-scan capability GSR doesn't have
today and this doc doesn't propose adding — noting it here so it isn't
mistaken for something §5's fix addresses.

## 6. Non-goals for this phase

- Rejection-semantics detection (§2, deferred to the finding-feedback loop).
- Changing `job_tracker`'s (or any consuming repo's) default review mode
  (§3 — shadow-run first, decide with data later).
- Full-repo cross-file pattern scanning (§5's related note).
- Anything that requires the finding-feedback API itself
  (`finding-feedback-requirements.md`) to already exist — §2's dedup logic
  only needs GSR's own prior PR comments, fetched fresh each run, not a
  persisted feedback store.

## 7. Eval harness enhancements (`tools/eval`)

The harness today (`evaluate.ts`) compares two *targets* (local/production/a
branch) against each other and against third-party bots (GCA, CodeRabbit) on
a fixed PR list (`config.json`'s `sample_prs`, currently 10 PRs from
`gemini-cli-fork`), using `validation.ts`'s deterministic diff-position check
plus an LLM judge (`llm-comparator-v2.ts`) for actionability/false-positive/
overlap scoring. That setup is good at "did A or B do better on this PR" but
structurally can't catch any of §2-§5, because:

- It's always a single one-shot review per PR — no simulated re-push, so
  Gap 1 (repeated findings across runs) never occurs in the harness.
- `sample_prs` are all first-review, single-pass PRs, with no fixture
  designed to require cross-file symbol resolution (Gap 4) or contain
  clearly-reference-only content (Gap 3).
- It has no *ground truth* — the LLM judge scores findings relative to each
  other and to GCA/CodeRabbit, not against a known "this line has a real bug
  / this line does not" answer, so there's no precision/recall number, only
  a qualitative comparison.

### 7.1 New fixture-based regression suite, using the `job_tracker` audit as ground truth

The manual audit produced exactly what a regression suite needs: real
findings with a human-verified outcome (fixed / correctly-ignored /
wrongly-ignored). Turn it into a repeatable eval track instead of a one-time
analysis:

- New config file, e.g. `tools/eval/fixtures/job_tracker_regressions.json`,
  listing specific `(prUrl, file, line)` tuples from the audit split into:
  - **`must_catch`** — findings from §1's "wrongly ignored" list that are
    still live in `main` today (`internal/ingest/filters.go`'s
    `containsAny`/`containsAnyWord` bugs, `internal/recruiter/store.go`'s
    missing `ctx.Done()` check in retry backoff, `internal/scoring/
    fallback.go`'s `Judge` passthrough). A rerun of GSR against these PRs
    that fails to reproduce these findings is a **recall regression**.
  - **`must_not_flag_high`** — the `design_prd/*.html` mockup and the
    one-off scratch scripts (§4). A rerun that raises these at
    HIGH/CRITICAL again means §4's dampening isn't working.
  - **`must_resolve_cross_file`** — PR #15's `applyConfig` case (§5). A
    rerun that still claims it's undefined is a direct regression check on
    §5's Tier 1 fix — and the deciding signal for whether Tier 2 is worth
    building at all.
- A new eval mode (`--fixture-mode regression`) runs each listed PR through
  the target(s), then scores deterministically: did the resulting findings
  include a match (same file, line within a small tolerance) for each
  `must_catch` entry, and exclude/dampen each `must_not_flag_high` and
  `must_resolve_cross_file` entry? Report precision/recall-style pass/fail
  counts, not just an LLM qualitative report — this is the piece the
  current harness structurally lacks. Matching logic can reuse
  `validation.ts`'s file-normalization approach.
- This is a **regression** suite (fixed, known-answer PRs), separate from
  the existing comparative harness — it belongs in `tools/eval` alongside
  `evaluate.ts` as its own entrypoint/script, not a mode flag on
  `runEvaluation`, since its semantics (pass/fail against ground truth) are
  different enough from "compare two targets qualitatively" to warrant
  staying separate rather than overloading `EvalOptions`.

### 7.2 Multi-push simulation, targeting Gap 1 specifically

Add a fixture that isn't a real PR but a small synthetic one (or a
`--simulate-pushes` mode against a real low-stakes PR): run the Action
entrypoint's review-and-post logic twice against the same PR — once, then
again with no changes to the flagged lines — and assert the second run's
posted-comment count for previously-seen `findingId`s is zero (or collapsed
into the summary per §2.1's step 4), not a full repeat. This is really a
test of `action-entrypoint.ts` + the new dedup logic from §2.1, best
expressed as a focused Jest test (`tools/eval/tests/` or, arguably more
naturally, `adk/backend/tests/` since it's testing Action behavior, not the
comparison harness) rather than a full `tools/eval` run — flagging the
question of *where* this test lives as something to settle during
implementation, not a strong opinion here.

### 7.3 Basic-vs-subagent comparison as a standing eval, not a one-off

§3's shadow-run data collection answers "does the swarm help on
`job_tracker` specifically, over time." The eval harness should also be able
to answer this on-demand for the existing `sample_prs` fixture set: since
`app.ts`'s `/api/review` endpoint already runs both orchestrators and the
`Evaluator` comparison in one call (§3.1), pointing `evaluate.ts` at that
endpoint with `compGroup` effectively already gets this — worth confirming
it's actually being exercised regularly (e.g. as part of whatever CI/cron
runs `tools/eval` today) rather than left dormant, and surfacing the
`Evaluator` comparison text more prominently in the aggregate report
(`generateAggregateReportV2`) specifically for Logic-category findings,
given §1's finding that category is the weakest.

## 8. Summary of concrete changes

| Gap | Change | Where |
|---|---|---|
| §2 repeated findings | Fetch prior GSR comments, compute content-hash `findingId`, skip reposting unchanged findings, collapse after N repeats | `action-entrypoint.ts`, `github.ts` |
| §3 swarm has no data | Optional `SHADOW_MODE` shadow-runs subagent orchestrator + `Evaluator` comparison in the Action, logged to step summary | `action-entrypoint.ts`, reuses `evaluator.ts` |
| §4 non-prod severity | `LOW_PRIORITY_PATH_PATTERNS` config, severity cap in `filterFindings` | `orchestrator.ts` |
| §5 cross-file blindness | Tier 1: decouple `useTriage` (aggregation) from `useDedup`, aggregate in both modes. Tier 2 (only if needed): on-demand full-file fetch for definition-shaped claims in remediation pass | `orchestrator.ts`, `action-entrypoint.ts`; `github.ts`/`agent.ts` for Tier 2 |
| Eval: regression suite | New fixture file + scorer using `job_tracker` audit as ground truth | `tools/eval/fixtures/`, new entrypoint |
| Eval: multi-push | Simulated double-review test asserting no duplicate finding IDs posted | `tools/eval/tests/` or `adk/backend/tests/` (TBD) |
| Eval: mode comparison | Confirm `Evaluator`'s existing basic-vs-subagent comparison is actually running regularly; surface Logic-category delta prominently | `evaluate.ts`, `llm-comparator-v2.ts` |

## 9. Open questions

1. Should §2's repost-suppression also suppress the *summary* line count
   (`**GSR Review** — N finding(s)`), or should N always reflect everything
   still outstanding regardless of repost status? (Leaning: N stays
   accurate — the summary count is right sitting is where "is this PR still
   dirty" should be reflected, only the noisy inline repetition goes away.)
2. §3's shadow-run adds one more Gemini call's worth of cost per PR on
   `job_tracker` for the trial window — worth confirming with whoever owns
   that repo's `GSR_GEMINI_API_KEY` budget before enabling.
3. §4's default `LOW_PRIORITY_PATH_PATTERNS` list is a guess at common
   conventions (`design_prd/`, scratch scripts) — worth validating against
   at least one more consuming repo before hardcoding defaults, since a
   pattern that's right for `job_tracker` could be wrong elsewhere.

## 10. Latency addendum (discovered after §1-§9 were written)

Follow-up investigation found `ReviewMetrics`/`AnalyzeResult` (`types.ts`,
`api-client.ts`) never record wall-clock duration — only token counts and
call counts. Real basic-mode latency was pulled directly from `job_tracker`'s
Actions history instead (68 successful `gsr-review.yml` runs, isolating the
`Run weitzer-org/gsr@main` step): **median 155s, average 169s, range
4s-462s** (scales with file count — basic mode's `useTriage=false` legacy
routing queues one 2-call discovery+remediation task per file through
`PromisePool(maxConcurrency=5)`). Subagent mode has **zero real executions**
to measure — all 81 `gsr-review-deep.yml` runs were `skipped` (§3's finding,
generalized to latency too). Structurally, swarm mode's latency scales with
**agent count** instead (one 2-call task per agent, aggregated across the
whole PR diff, plus a final `Deduplicator` call) — with ~6 unrestricted
default agents against `maxConcurrency=5`, swarm already needs 2 concurrency
rounds; trimming to ≤5 agents would collapse that to 1, a real structural
latency win, not just a cost one. This is folded into Phase 5 below rather
than its own phase, since `durationMs` instrumentation and §3's `SHADOW_MODE`
naturally produce this data together.

## 11. Implementation plan

Phased for separate implementation sessions (each phase = its own PR, per
this repo's "never self-merge" convention). Ordered so the eval regression
fixture (Phase 1) lands *before* any fix, giving a red baseline that proves
the fixture actually detects the problems it's meant to catch — later
phases turn specific entries green rather than writing fixtures to match
already-fixed behavior.

**Status key:** ⬜ not started · 🟨 in progress · ✅ done. Update this table
at the end of each phase's session so the next one (a fresh chat, with no
memory of this one) knows what's already landed.

| Phase | Scope | Depends on | Status |
|---|---|---|---|
| 1 | Eval regression fixture: `must_catch` / `must_not_flag_high` / `must_resolve_cross_file` lists + deterministic scorer (§7.1), using the `job_tracker` audit as ground truth | none | ✅ |
| 2 | Gap 4 Tier 1: decouple `useTriage` (aggregation) from `useDedup` (§5.1) | Phase 1 (to verify against `must_resolve_cross_file`) | ⬜ |
| 3 | Gap 3: `LOW_PRIORITY_PATH_PATTERNS` + severity dampening in `filterFindings` (§4.1) | Phase 1 (to verify against `must_not_flag_high`) | ⬜ |
| 4 | Gap 1: content-hash finding identity + Action-side repost suppression/collapse (§2.1) + multi-push simulation test (§7.2) | none (independent of 2-3, but easiest after they're merged to avoid rebase noise) | ⬜ |
| 5 | Gap 2: `SHADOW_MODE` (§3.1) + `durationMs` latency instrumentation (§10) + standing basic-vs-subagent eval reporting (§7.3) | Phases 2-4 merged (shadow-run data is most useful once the fixes it'd be comparing are in place) | ⬜ |
| 6 (conditional) | Gap 4 Tier 2: on-demand full-file fetch for out-of-diff symbol claims (§5.1 Tier 2) | Only open this if Phase 1's `must_resolve_cross_file` fixture still fails after Phase 2 — Tier 1 may already be sufficient | ⬜ (gate: rerun Phase 1's fixture after Phase 2 first) |

Each phase's session should re-read this file's relevant section(s) plus
`finding-feedback-requirements.md` where cross-referenced (Phase 4 reuses its
§5.3 content-hash scheme), verify the referenced code (file/line citations
may drift as other phases land — re-check, don't assume), implement, add
tests, run `/quick-review` before opening the PR, and flip this table's
status cell to ✅ (or 🟨 with a note, if left mid-stream).

**Phase 1 note:** fixture lives at `tools/eval/fixtures/job_tracker_regressions.json`
(4 `must_catch`, 3 `must_not_flag_high`, 1 `must_resolve_cross_file`, each
citing a real `(prUrl, file, line)` traced back to the commit/PR that
introduced it — PRs #1, #3, #4, #14, #15, not the #1/#4/#8/#15 guess this
phase started with). Scorer is `tools/eval/fixture-regression.ts` (own
entrypoint, `npm run eval:regression` in `tools/eval`), reusing
`validation.ts`'s file-normalization logic (extracted into exported
`normalizeFilePath`/`filePathsMatch` helpers so both callers share one
implementation). It scores only `source: 'basic'` findings from `/api/review`
— job_tracker's CI runs `mode: basic` exclusively (§1), so basic-mode output
is the one that has to match ground truth; scoring the combined basic+subagent
set would let the (currently-unused-in-prod) swarm mask a basic-mode
regression. **Baseline run against current `main`-equivalent build (this
branch, orchestrator/basic-prompt code untouched): 5/8 passing, 3/8 failing**
— confirms the fixture actually detects live-bad behavior, not a fixture
that's already vacuously green:
- `must_catch`: 3/4 passing (filters.go's `containsAnyWord`, store.go's
  missing `ctx.Done()`, fallback.go's `Judge` passthrough all reproduced).
  `containsAny`'s substring false-positive did **not** reproduce this run —
  plausible-but-unconfirmed explanation is LLM non-determinism rather than
  the bug being gone (the code is unchanged); worth re-running before trusting
  a single sample here.
- `must_not_flag_high`: 1/3 passing. The two scratch-script findings
  (`wait_for_app.sh`, `run_real_test.sh`) both still post at HIGH — expected,
  §4's dampening hasn't landed (Phase 3). The mockup HTML finding happened to
  come back capped or absent this run.
- `must_resolve_cross_file`: 1/1 passing — PR #15's `applyConfig` claim did
  **not** reappear this run. Given Tier 1 (Phase 2) hasn't landed and the code
  path (`useTriage=false` → file-by-file) is unchanged, treat this as the same
  LLM non-determinism caveat as above, not evidence the gap is already closed
  — re-run after Phase 2 lands before using this to decide whether Tier 2
  (Phase 6) is needed, per §5.1.
