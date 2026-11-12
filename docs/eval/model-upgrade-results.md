# GSR model upgrade — results (smoke pass only)

Pre-registered plan: `docs/eval/model-upgrade-test-plan.md` (committed as a7786b4 before any live call). Date: 2026-11-12.

## Bottom line

**No recommendation on quality can be made yet.** `MAX_LIVE_SPEND_USD` was blank, so per the task only Parts A–D and the smoke pass were run. The smoke pass is **one large PR × five arms × one repetition (n = 1)**; it proves the harness works end to end and gives measured token counts for a cost projection. It cannot rank the models. Every candidate is **UNDETERMINED** on both modes because ground truth, large-PR recall (needs ≥ 4 PRs) and meaningful judging are unmeasured. Nothing in production changed.

What the (valid) second smoke batch shows, as observations about this one PR and not findings about the models:

- All five arms completed, every call was served by the model requested, and there were 0 MAX_TOKENS, 0 timeouts, 0 parse failures and 0 stage API errors in the accepted results. BASE2's **first attempt failed ("terminated")** and was retried successfully; that is exactly what the attempt log and the first-attempt gate exist to record.
- The A/A control is noisy at n = 1: BASE vs BASE2 swarm 13 vs 11 findings (11 vs 16 in the first, invalid batch), basic-mode recall of BASE 0%. Any single-PR difference of that size is not evidence.
- 3.8 Flash returned fewer swarm findings (5; 4 at LOW) than BASE (13) in both smoke batches (3 and 2 in the first). This resembles the retrospective's "going quiet" pattern but at n = 1 it is a lead for the full matrix, not a result.
- Cost order depends on an unresolved billing question (see Cost): on recorded tokens Argon ($0.57 → $1.14 after 2026-12-01) is below 3.1 Pro ($0.69) today and above it after the change; if thinking is billed on top, 3.1 Pro is ≈ $2.15 and Argon stays ≈ $0.62.

## What ran (live calls)

| Step | Calls | Notes |
|---|---|---|
| Capability probe | 19 | `docs/eval/data/probe-2026-11-12T01-37-24-602Z.json` |
| Smoke batch 1 (**invalid for comparison**, kept as evidence) | 5 reviews, 5 attempts; 16 judge calls | The local proxy dropped while BASE and BASE2 were finishing: their deduplicate and evaluate calls failed (`fetch failed`, `ECONNREFUSED`), and the harness reported the runs as clean. Found by the verifier; see "Verifier" |
| Smoke batch 2 (**valid**) | 5 reviews, 6 attempts (cap 10); 16 judge calls (cap 20) | gsr #74 (20 files, large), same seed, harness fixed first. 74 Gemini calls inside the reviews (14–16 per arm) |
| Spend | ≈ $3.9 recorded for the ten review runs (batch 1 ≈ $1.8, batch 2 ≈ $2.1; ≈ $7 if thinking tokens are billed on top), plus a few cents for the probe and unmeasured judge cost | computed from recorded tokens at PRICE_TABLE rates (Argon's rate unverified); the failed BASE2 attempt's cost is not in the records |

Raw data: `docs/eval/data/smoke2-20261112.tar.gz` (valid batch) and `docs/eval/data/smoke-20261112.tar.gz` (invalid batch 1) (each a batch dir incl. manifest with per-arm resolved routing, every attempt, diffs, judge records, per-call usage records). The large full-matrix data does not exist yet.

## Integrity results

- **Routing**: each server's `/api/status` matched its arm file before any review (the harness aborts otherwise). Dedup is on the arm's model in every arm.
- **Served model = requested**: 18/18 probe generate calls and every smoke call (0 mismatches in all stage tables). Judges: 16/16 records served by the requested judge, 0 invalid.
- **Probe (verified, from the saved JSON)**:

| | 3.1 Pro | Argon | 3.8 Flash |
|---|---|---|---|
| Discovery schema → valid JSON | ok | ok | ok |
| `thinkingBudget: 4096` (dedup) | ok | ok | ok |
| `thinkingLevel: LOW` | ok | ok | ok |
| `thinkingLevel: MINIMAL` | **400 "not supported for this model"** | **400** | **400** |
| `caches.create` | ok | **400 "Explicit caching is not supported for models/gemini-4-argon"** | ok |
| `maxOutputTokens: 64` | thinking ate the cap (3 output, 57 thought) | all 64 as output (no thinking) | thinking ate the cap (1 output, 59 thought) |

  No model failed a must-have, so none was dropped. `gemini-2.5-pro` (default judge) answered. MINIMAL is unusable on all three here, including 3.8 Flash (consistent with Sound Builder).
- **Thinking tokens are reported separately from output tokens (verified).** On all 13 generate calls, `totalTokenCount = prompt + candidates + thoughts` exactly. So `candidatesTokenCount`, which `usage.ts` bills as output, **excludes** thinking. Whether Google bills thinking at the output rate is a pricing fact not verified here; if it does, `usage.ts` under-reports spend for thinking-heavy models. This matters: BASE spent ~98k thinking tokens in this one review (vs 6k for Argon, 2k for 3.8 Flash at LOW), and the "billed on top" column (below) is then the likelier figure for 3.1 Pro. This revises plan assumption U2 from "unverified" to "evidence against".
- **Safety finding about the environment**: this session's shell is configured with another project's real S3 bucket and credentials. The harness therefore never lets a spawned backend or the judge step inherit them: all S3/AWS/ingest variables are scrubbed and storage is redirected to a local null sink (tests include a real AWS SDK client against it). The smoke run used the sink.

## Gate tables

Smoke batch 2, per candidate vs BASE (full tables with details are in the archived `report.md`). Gates added after the verifier's finding: stage API errors per stage ≤ BASE (also PASS for all three).

| Gate | ARGON | FLASH38 | FLASH38_LOW |
|---|---|---|---|
| served-model mismatches = 0 | PASS | PASS | PASS |
| first-attempt success ≥ BASE − \|BASE−BASE2\| | PASS (100%) | PASS | PASS |
| MAX_TOKENS + timeouts per stage ≤ BASE | PASS | PASS | PASS |
| parse failures per stage ≤ BASE | PASS | PASS | PASS |
| ground truth: no FAIL | **UNMEASURED** | **UNMEASURED** | **UNMEASURED** |
| must_not_flag_high | **UNMEASURED** | **UNMEASURED** | **UNMEASURED** |
| **Decision (basic and swarm)** | **UNDETERMINED** | **UNDETERMINED** | **UNDETERMINED** |

The operational gates passing on one review each carries almost no information (0 events for BASE too). Ground truth is unmeasured because **no ground-truth PR can be reviewed from this session**: `gemini-cli-fork` (the 10 seeded PRs) and `job_tracker` return 403 ("GitHub access to this repository is not enabled for this session"); the attach request was declined by the permission classifier and not worked around.

## Statistics

Not computable on the smoke batch: every comparison has 1 paired PR (< 4 → UNMEASURED). The statistics module and its FAIL/WARN/PASS rules are pinned by 22 unit tests, including a null comparison (same data vs itself → PASS, zero-width interval) and a computed −13% case that is a WARN, not a FAIL.

Agreed judge verdicts, batch 2 (n = 1 pair per cell; two judges): basic: ARGON agreed win; FLASH38 and FLASH38_LOW judges disagree; BASE2 agreed tie. Swarm: FLASH38 and FLASH38_LOW agreed win (despite far fewer findings, the judges rate precision/actionability, not volume); ARGON and BASE2 judges disagree. The A/A control already draws a disagreement in swarm mode: single verdicts are noise, and judging cannot see "went quiet" (retrospective §2), which is why recall and ground truth are separate measures.

The recall comparison in the statistics now uses the A/A control's recall of BASE as its reference. The first version compared candidates with BASE's own recall of itself (always 100%), which would have made every candidate, and the control, FAIL (verifier finding).

## Cost (measured tokens, batch 2, this one 42 KB-patch review; today / after the price change)

| Arm | Cost/review today | From 2026-12-01 | From 2027-01-01 | If thinking billed on top (today) | Review wall-clock |
|---|---|---|---|---|---|
| BASE (3.1 Pro) | $0.69 | $0.69 | $0.69 | +$1.47 | 347 s |
| BASE2 | $0.49 | $0.49 | $0.49 | +$1.06 | (first attempt failed; retry not comparable) |
| ARGON (**price unverified**) | $0.57 | $1.14 | $1.14 | +$0.05 | 163 s |
| FLASH38 | $0.16 | $0.16 | $0.32 | +$0.22 | 210 s |
| FLASH38_LOW | $0.15 | $0.15 | $0.30 | +$0.01 | 51 s |

**Update after the PR was opened (web search, second-hand):** a search over `ai.google.dev` returned snippets of Google's pricing page whose output line is titled "Output price (**including thinking tokens**)": Argon Standard $10 through 2026-11-30 then $20 from 2026-12-01; 3.8 Flash $3.75 then $7.50 from 2027-01-01; 3.1 Pro $12 (≤200k-token prompts) / $18 (>200k). Together with the probe (thoughts are reported separately from `candidatesTokenCount`), that makes **the "billed on top" column the likely true cost**, and it corroborates the Argon/3.8 Flash rates in `PRICE_TABLE`. I did not fetch the page itself (blocked here), so both stay "corroborated, not verified". Consequence: `usage.ts` very likely **under-reports spend on thinking-heavy calls today** (3.1 Pro most of all). Not changed in this PR (it would move production dashboard numbers); see TODO #42.

**Which column is right decides the cost ranking; the update above says the "on top" column.** The probe shows `candidatesTokenCount` excludes thinking tokens (verified). `usage.ts` bills only that, following a pricing-page reading that the output rate "includes thinking"; if Google instead bills thoughts at the output rate, the "on top" column is the real cost and BASE (≈ $2.15) is ~3.5× Argon's today (≈ $0.62). The pre-registered plan (U2) assumed the opposite and presented the recorded-token column as the headline; that is a deviation (below). BASE's cost also varies run to run: $0.43 in the invalid batch 1 (missing two calls) vs $0.69 here. Latency is from one run at 5-way concurrency; do not compare it with any other batch.

### Projection for the full matrix (not run)

Full matrix = 23 PRs (total patch 1,066 KB = 25.4× the smoke PR) × 5 arms × 2 reps = 230 reviews, then 736 judge calls. Scaling the batch 2 per-review tokens (batch 1's figures were ≈ 10–15% lower because two baseline calls were missing) linearly by patch size (an upper-leaning assumption: outputs and thinking grow slower than diffs; the fixed per-call prompt is small):

| | Reviews (recorded basis) | Reviews (thinking billed on top) |
|---|---|---|
| Today's rates | ≈ $95–$110 | ≈ $230–$250 |
| After 2026-12-01 (Argon $4/$20) | ≈ $125–$140 | ≈ $255–$280 |

Judging: ≈ $30–50 (**unmeasured estimate**: ~8k input + ~3k output/thinking per call). **Total ≈ $130–320, wall-clock ≈ 4–5 hours** (≈ 4 min per (PR, rep) × 46, arms in parallel). Because the cap was blank this was not run. To run it: `compare-arms.ts … --live --max-review-calls 250`, then `EVAL_MAX_JUDGE_CALLS=800 judge-batch.ts`, then `report.ts` (commands in `tools/eval/README.md`). **Prerequisite for any ground-truth result:** attach `weitzer-org/gemini-cli-fork` (and `job_tracker`) to the session.

## Recommendation per mode

- **Basic and swarm: undetermined. Do not switch the default model on this evidence.**
- Leads for the full run, no more: (1) 3.8 Flash may under-report on large PRs in swarm mode (3 vs 11 findings); (2) FLASH38_LOW is ~7× faster and ~3× cheaper but reported the fewest findings; (3) Argon is the only arm that matched BASE's swarm finding volume (20 vs 11) but at higher cost; (4) 3.1 Pro's thinking cost may be materially under-billed in `usage.ts`, which affects every cost comparison involving it.

## What wasn't tested

Everything in the plan's §13, plus: any ground-truth PR; any PR other than gsr #74; repetitions > 1; small PRs; the 10 additional large PRs; retries (no attempt failed); Argon's real price; production reachability of the Fly URL (blocked here); the localization arm.

## Deviations from the plan

- The capability probe, a second smoke pass, and smoke judging (2 × 16 calls) were run under the smoke authorization (plan D14). The second smoke pass repeats the first because the first was invalid.
- **Added gate**: stage API errors per stage ≤ BASE (not in plan §6). A failed deduplicate/evaluate call degrades silently, and the harness had no flag for it. Added after the first smoke batch, before the second.
- **Changed reference**: recall is compared with the A/A control's recall of BASE rather than BASE's own (always 100%); plan §5 did not specify this and the naive reading was degenerate.
- Plan U2 ("candidates includes thinking") is contradicted by the probe; costs are shown both ways and the ranking is stated as unresolved.
- `concurrent_arms` on a first attempt now records the planned group size; before, it recorded start order (1..5).
- Storage redirection (`nullS3.ts`) was added after finding the environment's real-bucket credentials (see Integrity), before any live review.
- Early in the session, a few backend test runs were made with a bare `jest` (no `--experimental-vm-modules`) in a shell that holds those real S3 credentials; unmocked suites may have attempted usage-record writes to that bucket. I cannot tell whether any succeeded.

## Verifier

One `opus-verifier` recomputed the batch-1 report from the raw run, diff, judge and probe files with its own scripts. **Confirmed**: per-stage counts, findings per source, hallucination/validity counts, recall in both directions, cost per review at all three price dates (to the cent), judge verdict logic and un-swap direction, agreed/disagreed counts, the probe's token identity (`total = prompt + candidates + thoughts` on all 13 calls that returned usage; it only says something about thinking for the 9 that reported thoughts), and `compareMeasure` against plan §5. **Where it disagreed with the report** (all accepted, with the response):

1. *Critical*: BASE and BASE2 lost their deduplicate and evaluate calls (proxy dropout) yet were reported clean, so swarm counts, recall, judging and cost compared different pipelines. → I reproduced it from the run files and logs; added the `stage_error` flag/outcome/gate and a report column; re-ran the smoke (batch 2).
2. *High*: the recall comparison used BASE's recall of itself (1.0), so even an A/A copy would FAIL and ADOPT was unreachable. → reference is now the control's recall; UNMEASURED without a control; tests added.
3. *High*: the plan/report/`usage.ts` comment said thinking is probably already in the output count; the probe says otherwise. → corrected here and in the `usage.ts` comment; both cost columns shown.
4. *Medium*: `concurrent_arms` recorded start order, and "equal load" is not independently supported (arms finished at 48 s to 227 s). → field fixed; the claim is stated as "simultaneous start", not equal load.
5. *Low, not changed*: the backend's top-level `metrics.calls` counts agents, not Gemini calls (pre-existing; the report uses the stage counts); a 1-output-token FLASH38_LOW remediation call was not flagged by any gate; judge 2 differs between pairs by pre-registration, so §6 verdicts are not comparable across arms; the plan §10 `models.get` outputs and HTTP-status checks have no saved artifact (they are quoted from commands run in this session).

The verifier did not re-run batch 2; its numbers come from my report plus the test suite. An independent check of batch 2 was not repeated (one verifier is the allowed budget).
