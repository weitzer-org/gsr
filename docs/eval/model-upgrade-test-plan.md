# GSR model upgrade — pre-registered test plan

**Status: pre-registered.** This file is committed before any live Gemini call of this task (the capability probe and the smoke pass included). The arms, PR set, repetitions, gates and decision rules below are fixed; results go in `docs/eval/model-upgrade-results.md`, and any deviation from this plan is recorded there under "Deviations", never edited back into this file.

Question: should GSR move off `gemini-3.1-pro-preview` (today's default) to `gemini-4-argon` or `gemini-3.8-flash`? The output of this work is a **recommendation**; the switch is the owner's call. Nothing here changes any default model.

Inputs: `gemini-flash-model-investigation.md` (GSR's 3.7-flash retrospective), `deduplicator-duplication-bug.md`, and Sound Builder's playbook (`sound-profile-builder/docs/eval/gemini-model-upgrade-test-plan.md` §2–5a, 9a, 9b; `single-agent-ab.md` §2d). Their traps are mapped to what this harness does about each in §2.

## 1. What is being compared

| Arm | Every stage (discovery, remediation, basic, deduplicate, evaluate) | Thinking | Role |
|---|---|---|---|
| BASE | `gemini-3.1-pro-preview` | default (nothing sent) | baseline |
| BASE2 | `gemini-3.1-pro-preview` | default | A/A control: same config as BASE in the same batch; calibrates the gates, never "decided" |
| ARGON | `gemini-4-argon` | default | candidate |
| FLASH38 | `gemini-3.8-flash` | default | candidate |
| FLASH38_LOW | `gemini-3.8-flash` | `GEMINI_THINKING_LEVEL=LOW` (discovery / remediation / basic only; the deduplicator keeps its `thinkingBudget: 4096`) | candidate |

Definition file: `tools/eval/arms/model-upgrade.json`. On **every** arm: same git commit (one checkout, N backends on different ports), `USE_CONTEXT_CACHING=false`, `GEMINI_MAX_OUTPUT_TOKENS=32768`, and all five stage models set explicitly (the harness refuses an arm that leaves one to a fallback). The harness reads each running server's `/api/status` and aborts the batch if the resolved routing differs from the arm file, so "BASE" cannot silently be running a different dedup model (the retrospective never audited that).

Modes. Consumer repos run `mode: basic` (the basic findings, no deduplicator); the swarm runs only with the `deep-review` label. `/api/review` returns both together, tagged `source: basic` / `subagent`. Every measure below is computed **per mode**, never pooled. "Swarm" = `subagent`.

## 2. Traps from the earlier investigations, and what is done about each

| Trap (retrospective §4 / Sound Builder) | Handling |
|---|---|
| Pooled aggregation over different denominators | The unit is the PR; every comparison is paired by PR within one batch; a PR with no value on either side is dropped from that pair and the count of pairs used is printed. |
| Judge JSON keyed by display label | `resolveV2Metrics` matches only the labels actually passed in. |
| Judge score transcription / both targets resolving to one object (bug #8, `normalizeV2Metrics` fallback) | Fixed: the hard-coded `local`/`production` fallback is gone; ambiguous keys, a missing target, identical labels or `targetA === targetB` mark the result **implausible**, and implausible rows are excluded. Regression test reproduces the exact case. |
| Judge position bias | Order randomized per pair from a seeded RNG, un-swapped afterwards; both judges see the same order for a pair; reviewers are shown under blind labels ("Reviewer 1/2"), not arm or model names. |
| Retry selection bias (#5, #6) | Every attempt is saved with its outcome. Only an *incomplete* review is retried; a complete review with MAX_TOKENS / timeout / parse failure / served-model mismatch is **kept and flagged**, not retried away. First-attempt completeness and clean rates are reported per arm. This is still only a partial fix: a fast broken result and a slow healthy one are still treated differently by the client timeout, and the report says so wherever retries occurred. |
| `computeRecall` rewards whichever model writes more; proximity matches are optimistic | Demoted to a secondary measure. Ground truth is primary. 10 matched pairs are read by hand before conclusions (§9 of the results doc). |
| `DEDUPLICATOR_MODEL` never audited | Pinned on every arm and verified from `/api/status`. |
| Cost billed from an unverified thinking assumption (#9) | Thinking tokens are *not* added to cost (same as `usage.ts`); an "if billed on top" column bounds the error. The probe records `total - prompt - candidates - thoughts` as evidence. |
| 3 large PRs can only show large gaps | 10 more large PRs, chosen by the written rule in §3. |
| Arm order confounded with time (Sound Builder) | All arms of a (PR, rep) run **at the same time**; PRs run one after another; start order shuffled per (PR, rep) from a recorded seed. |
| Requested ≠ served model (3.5 Flash served as 3.6) | `response.modelVersion` is recorded as `servedModel` on every usage record and per stage in the review response; any mismatch on an accepted result fails a gate. |
| An unpriced model shown as $0 | `costUnknown` flag; summaries and the report say "unknown (N calls excluded)". |

## 3. PR set, repetitions

**23 PRs**: the 13 in `tools/eval/config.json` (10 seeded-bug PRs in `weitzer-org/gemini-cli-fork` #3–#12, and `weitzer-org/gsr` #50, #57, #58) plus 10 more large PRs chosen by this rule (implemented in `tools/eval/select-large-prs.ts`, with tests; output `tools/eval/fixtures/model-upgrade-prs.json`):

> Merged PRs of `weitzer-org/sound-profile-builder` and `weitzer-org/gsr`, newest merge first, taken alternately (sound-profile-builder first), merged on or before 2026-11-12, scanning at most the 60 most recently merged per repo, excluding PRs already in `config.json`. A PR qualifies if it has **≥ 10 changed code files** (extension in ts, tsx, js, jsx, mjs, cjs, go, py, rs, java, kt, rb, sh, sql, css, scss, html; not under `docs/`; with a patch; not on the backend's own ignore list) and its total patch is **≤ 1,000,000 bytes**. Take the first 5 qualifying per repo. Docs-only PRs cannot qualify because markdown/text files are not code files.

Selected (run 2026-11-12; 60 merged PRs scanned per repo):

| Repo | PR | Merged | Code / total files | Patch | Title |
|---|---|---|---|---|---|
| sound-profile-builder | #272 | 2026-11-12 | 15 / 17 | 70 KB | #271 eval_report: completeness gates, per-query paired comparison and  |
| gsr | #93 | 2026-10-06 | 40 / 98 | 131 KB | Prove It Phase 0: witness types, author prompt, verdict function, sand |
| sound-profile-builder | #270 | 2026-11-11 | 38 / 60 | 226 KB | #262/#263 eval tooling: per-agent thinking and routing, -treat, -inter |
| gsr | #82 | 2026-09-02 | 11 / 14 | 55 KB | Phase 5: SHADOW_MODE, durationMs latency instrumentation, eval reporti |
| sound-profile-builder | #267 | 2026-11-11 | 15 / 17 | 64 KB | #263 part 2: -replay-upstream (replay same-batch PROD outputs for agen |
| gsr | #74 | 2026-08-29 | 10 / 20 | 42 KB | Deduplicator reliability fixes, prompt template bug, eval harness meas |
| sound-profile-builder | #264 | 2026-11-11 | 15 / 17 | 44 KB | #263 part 1: retry 504/timeout runs, eval_subagent uses the research s |
| gsr | #73 | 2026-08-29 | 28 / 30 | 127 KB | Add usage metrics dashboard (tokens/cost by model, project, workload) |
| sound-profile-builder | #269 | 2026-11-11 | 13 / 17 | 79 KB | Send the bridge's log with job results and its warnings with the heart |
| gsr | #63 | 2026-08-17 | 15 / 21 | 82 KB | PR comment feedback loop, Phase 3: report accepted/rejected outcomes |

Size class in every table: **large** = the review's diff has ≥ 10 files (what the model actually sees), **small** otherwise; reported separately and together. The three config gsr PRs are large (18, 12, 15 files); the ten seeded PRs are small (1–4 files). Expected: 13 large, 10 small.

**Repetitions:** 2 per PR per arm (configurable). Reps are averaged within a PR before any comparison.

**PRs this token cannot read are excluded and listed in the manifest**, not retried forever. At the time of writing the session's GitHub token cannot read `gemini-cli-fork` (HTTP 403, "GitHub access to this repository is not enabled for this session"), so the seeded-bug PRs cannot be reviewed live from this session; see §10 and the results doc.

## 4. Measures

1. **Ground truth (primary).**
   - *Seeded bugs*: `tools/eval/fixtures/seeded_bugs.json`, one bug per seeded PR with NEW-file line ranges taken from the PR's own diff (merge-base..branch tip, read with git; every range was machine-checked to lie on added lines). Caught = a finding of the scored source in the same file within ±3 lines of any location. Per mode. Unmatched HIGH/CRITICAL findings on those PRs are reported (informational).
   - *job_tracker audit fixture* (`fixtures/job_tracker_regressions.json`, via `fixture-regression.ts`'s own scoring rules, now exported and reused per arm): `must_catch`, `must_not_flag_high`, `must_resolve_cross_file`. Scored only if those PRs are in the batch (they live in `weitzer-org/job_tracker`, out of this session's reach).
   - **Known limitation:** every seeded diff has an `// INTENTIONAL DEFECT` comment next to the bug. Catching it is easy; expect a ceiling effect. A miss is informative; a hit proves little.
2. **Recall against BASE (secondary), both directions**, greedy 1:1, ±10 lines, on diff-validated findings (`computeRecall`). Same PR, same rep.
3. **Hallucination**: findings that fail `validateFindingsAgainstDiff`, and the count of findings.
4. **Judge (agreed verdicts only).** Judge 1 = `JUDGE_MODEL` (default `gemini-2.5-pro`); judge 2 = `JUDGE_MODEL_2` (default `gemini-3.8-flash`) but never a model in the pair being judged (for FLASH38\* pairs the first alternate not in the pair, `gemini-4-argon`). Per candidate (and the control) vs BASE, per mode, per (PR, rep). Inputs are diff-validated findings only; bot (GCA/CodeRabbit) findings are not passed. Verdict from the judge's scores: higher *actionability* wins; on equal actionability fewer *falsePositives* wins; else tie. Only verdicts both judges agree on count; disagreements are listed; a record from a judge served by a different model than requested, an implausible score block, or a failed call is invalid (neither agreed nor disagreed).
5. **Operational, per stage and mode**: MAX_TOKENS count, timeouts (client-side ETIMEDOUT + API timeouts), parse failures, served-model mismatches, thinking tokens, first-attempt completeness / cleanness, retries, never-completed.
6. **Latency (p50/p95) and cost per review** at today's rates, from 2026-12-01 (Argon $4/$20) and from 2027-01-01 (3.8 Flash $1.50/$7.50). Latency/cost are compared only inside one batch (one execution mode, one concurrency), and only for runs accepted on their first attempt.

## 5. Statistics (per PR)

For each candidate vs BASE, on each measure: mean per-PR difference, PRs lower/higher/equal, exact two-sided sign test, 95% bootstrap interval over PRs (4000 resamples, fixed seed). Counts: change = (mean cand / mean base − 1) in **%**; shares: change = (mean cand − mean base) in **points**. Rules (Sound Builder #271):

- **FAIL**: the whole interval is below −10.
- **WARN**: the interval's upper bound is below 0 **and** the sign test gives p ≤ 0.10.
- **WARN is not a pass.**
- Fewer than 4 paired PRs: identical → PASS, otherwise UNMEASURED.

Pinned by `tools/eval/tests/stats.test.ts`, including the null comparison (the same data against itself: PASS, zero-width interval). Small PRs, large PRs and all together are reported separately. Comparisons with the A/A control are expected to show nothing; if the control FAILs or WARNs on a measure, that measure's verdicts for the candidates are not trusted (the threshold is then data about noise, not about the candidate).

## 6. Gates (a candidate fails if any gate fails; compared with BASE **in the same batch**)

1. Served-model mismatches = 0 (accepted results; strict id match after stripping `models/`, unless a pin from the probe says an alias is the same model).
2. First-attempt success rate ≥ BASE's − |BASE − BASE2|. ("Success" = a complete review came back on attempt 1; the clean rate is also reported.)
3. MAX_TOKENS + timeouts, per stage ≤ BASE's.
4. Schema/parse failures, per stage ≤ BASE's.
5. Ground truth: no FAIL on seeded-bug catch rate or `must_catch`.
6. `must_not_flag_high`: no more false alarms than BASE.

A gate that cannot be measured is **UNMEASURED, not PASS**, and the candidate is then UNDETERMINED for that mode.

## 7. Decision rule (per mode: basic, swarm)

**ADOPT** a candidate iff it passes every gate, has no FAIL *or WARN* on ground truth and on large-PR recall, and the agreed judge verdicts show wins ≥ losses. Anything with a FAIL gate/verdict or wins < losses is **DO NOT ADOPT**; anything otherwise unmeasured is **UNDETERMINED**. Cost and latency only break ties between candidates that both ADOPT; they never outweigh a quality loss. Note that Argon at standard rates costs more per token than 3.1 Pro ($4/$20 vs $2/$12 from 2026-12-01; unverified, see §12).

## 8. Procedure and budget

- **Spending cap** (`MAX_LIVE_SPEND_USD`) was **blank** when this task started. Per the task's own rule: Parts A–D and the **smoke pass** are done; the full matrix is not run; the projected cost goes in the results doc. The capability probe (≈20 calls) is run as the smoke pass's go/no-go (Decision D14).
- Every live script has a hard call cap with no default: `compare-arms.ts` (`--max-review-calls` / `EVAL_MAX_REVIEW_CALLS`, and it refuses a cap below the plan's first-attempt count), `judge-batch.ts` (`EVAL_MAX_JUDGE_CALLS`), `probe-models.ts` (`--max-calls`). All three are dry-run by default.
- **Smoke pass**: 1 large PR × all 5 arms × 1 repetition. Checks that every file the report needs exists and has the right shape; projects the full matrix's cost from the measured tokens.
- **Full matrix** (not run without an owner-set cap): 23 PRs × 5 arms × 2 reps = 230 reviews, then judging (≤ 4 comparisons × 2 modes × 2 judges × 46 (PR, rep) = 736 judge calls), then the report.
- **Localization (conditional)**: only if a candidate fails on quality *and* budget remains: one extra arm with the candidate on discovery only and everything else on BASE.
- All Node processes run with `NODE_USE_ENV_PROXY=1` here (Node's built-in fetch otherwise ignores `HTTPS_PROXY`; measured: GitHub API 401 without it, 200 with it).

## 9. Verification before conclusions

BASE vs BASE2 shows no difference; 10 matched recall pairs read by hand; 5 agreed judge verdicts checked against the findings; the raw output of any thin-looking run read before blaming the model (Sound Builder's apparent regression was a prompt defect that newer models follow more literally). One `opus-verifier` recomputes the headline numbers and the gate verdicts from the batch directory; where it disagrees is stated in the results doc.

## 10. Environment findings that constrain this run (verified 2026-11-12)

- `GEMINI_API_KEY` and `GITHUB_TOKEN` are set. Gemini API host reachable (HTTP 200 on `models.list`). Token reads `weitzer-org/gsr` (200) and, after attaching it, `weitzer-org/sound-profile-builder` (200); it gets **403** on `weitzer-org/gemini-cli-fork` and `weitzer-org/job_tracker` ("GitHub access to this repository is not enabled for this session"). The environment's own documentation says to reconnect GitHub / attach the repo; the attach request for `gemini-cli-fork` was declined by the permission classifier and was not retried or worked around. Consequence: no ground-truth PR can be reviewed live in this session.
- `fly.dev` hosts are blocked by the sandbox proxy (CONNECT 403): the corrected `production_url` cannot be probed from here, and usage reporting to the production dashboard will fail harmlessly.
- `models.get` (run with the key) shows all three model ids exist: `gemini-3.1-pro-preview` (output limit 65536, `createCachedContent` listed), `gemini-4-argon` (output limit **32768**, **no** `createCachedContent`), `gemini-3.8-flash` (65536, `createCachedContent` listed).

## 11. Decisions

| # | Decision | Why |
|---|---|---|
| D1 | `GEMINI_MAX_OUTPUT_TOKENS=32768` on every arm | It is Argon's `outputTokenLimit` (the lowest of the three), so the cap binds identically everywhere. It may also bind thinking: a cap that thinking can eat shows up as MAX_TOKENS, which is a gate. |
| D2 | `BASIC_MODEL` governs **every** call the basic orchestrator makes (its discovery and remediation passes too) and the legacy per-file path; `DISCOVERY_MODEL`/`REMEDIATION_MODEL` govern only the swarm | The basic mode is a one-agent run through the same two-pass code; routing it by the swarm variables would make "BASIC" arms unmeasurable independently. |
| D3 | `GEMINI_THINKING_LEVEL` applies to discovery, remediation, basic and legacy; **not** to the deduplicator (keeps `thinkingBudget: 4096`) or the evaluate call | Matches the task text; the dedup budget was root-caused for a >5 min hang. |
| D4 | Invalid `GEMINI_THINKING_LEVEL` / `GEMINI_MAX_OUTPUT_TOKENS` fails server **startup** | A typo would otherwise run an arm silently unconfigured. Unset = today's behaviour exactly (tests assert no `maxOutputTokens`/`thinkingConfig` key is sent). |
| D5 | `/api/status` keeps `model` (= `GEMINI_MODEL`) and adds `stageModels`, `maxOutputTokens`, `thinkingLevel`, `contextCaching` | Additive; the deduplicator does not follow `GEMINI_MODEL` and now that is visible. |
| D6 | Stage metrics ride in the `done` frame as `metrics.stages.{subagent,basic,shared}` (and inside each orchestrator's own metrics); `recordParseFailure`'s duplicate record is an annotation, not a second call | Keeps basic and swarm separate; avoids double-counting tokens/latency/finish reasons. |
| D7 | `costUnknown` is set only on a **successful** call to an unpriced model; rollup fields `costUnknownCalls`/`totalCostUnknownCalls` are optional and the rollup `schemaVersion` is **not** bumped | A failed call has no tokens; old cached rollups simply read as 0 unknown. A bump would invalidate every cache for a purely additive field. |
| D8 | Retry only incomplete reviews; keep and flag complete-but-flagged ones | Retrying flagged reviews selects for luck (bug #6). |
| D9 | First-attempt success for the gate = a complete review on attempt 1; "clean" (no stage flag) is reported alongside | Stage flags have their own gates (3, 4, 1). |
| D10 | Judge verdict = actionability, then fewer false positives, then tie; bot findings not passed; blind labels | Pre-registered scalar from fields the judge already returns. |
| D11 | A/A control (BASE2) is judged and statistically compared but never "decided" | It exists to show the gates do not fire on noise. |
| D12 | `production_url` in `config.json` (and the identical stale value in `eval-config-ablation.json`, `eval-single-pr.json`) → `https://gsr-code-review.fly.dev`; the archived run record is untouched | `fly.toml` says `app = 'gsr-code-review'`; the Fly URL is also hard-coded in `usage.ts`. Reachability could not be tested from here (proxy). |
| D13 | Large-PR set by the written rule in §3 | Fixed before looking at any result. |
| D14 | The capability probe (~19 calls) runs as part of the smoke authorization | The blank cap authorizes the smoke pass; the probe is its go/no-go (a model that can't do structured output would waste the smoke). Probe cost is a few cents. |
| D15 | Argon's price row is the Sound Builder figure, marked unverified in code, TODO.md and here | No primary source reachable (see §12). |
| D16 | `tools/eval/usage.ts` gets price rows for every judge model (2.5 Pro, 3.1 Pro, 3.8 Flash, Argon) with the same scheduled changes | A judge on a model with no row would record $0. |
| D17 | `.gitignore` gets negations for `docs/eval/model-upgrade-results.md` and `docs/eval/data/`; raw batch directories stay ignored (`*results*`) | The required deliverable's name matches `*results*`. |
| D18 | Seeded-PR titles come from `create-prs.ts`; the bug locations come from the diffs | The live PR text could not be read (403). |

## 12. Unverified assumptions

| # | Claim | Status |
|---|---|---|
| U1 | Argon $2/$10 → $4/$20 on 2026-12-01; 3.8 Flash $0.75/$3.75 → $1.50/$7.50 on 2027-01-01 | **Unverified.** From Sound Builder's docs (Google Cloud pricing page fetched 2026-11-05 by them). `ai.google.dev` unreachable here; `cloud.google.com/vertex-ai/generative-ai/pricing` returned 301 with no readable body. TODO.md #46. |
| U2 | `candidatesTokenCount` already includes thinking tokens (so cost is not under-reported) | **Unverified.** Google's wording says the output rate includes thinking; the probe records the token-sum residual per model as evidence, nothing more. The "billed on top" column bounds it. |
| U3 | `modelVersion` equals the requested id for all three models | Checked by the probe on each call; pins are added only if the probe finds an alias. |
| U4 | Argon has no context caching | Model metadata lists no `createCachedContent` (verified); `caches.create` is tested by the probe. Caching is off on all arms regardless. |
| U5 | `gemini-3.8-flash` rejects MINIMAL (Sound Builder: HTTP 400) | Re-tested by the probe; not used by any arm. |
| U6 | Sound Builder's findings (Argon faster, 3.8 Flash thin on its Architect) transfer to GSR's review workload | **Assumption.** Different task; nothing here depends on it. |
| U7 | `gemini-2.5-pro` still answers as the default judge, and is not about to be shut down | The probe checks it answers. Sound Builder's own doc says shutdown dates are unconfirmed. |
| U8 | The seeded PRs' live text and base branch match `create-prs.ts` and the merge-base used for the locations | Unverified (403). The line numbers are from the branch diffs themselves. |
| U9 | Two repetitions are enough to separate a real regression from run-to-run noise | Weak: the retrospective estimated 55–65 PRs for a 5-point effect. The A/A control quantifies the noise but cannot add power. |
| U10 | The harness's arms see equal API load | By construction (simultaneous); not independently measurable. 429/503 counts are in the attempt log. |

## 13. Not tested (by design)

Prompt changes; context caching on any arm; size-based routing; batching; MINIMAL thinking; HIGH thinking (Sound Builder: 2.3× slower, no gain); Argon with non-default thinking; the feedback-loop/adjudicator model; Prove It; the Action runner path; any `job_tracker` or Sound Builder code.
