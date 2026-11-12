# GSR model upgrade — results (smoke pass only)

Pre-registered plan: `docs/eval/model-upgrade-test-plan.md` (committed as a7786b4 before any live call). Date: 2026-11-12.

## Bottom line

**No recommendation on quality can be made yet.** `MAX_LIVE_SPEND_USD` was blank, so per the task only Parts A–D and the smoke pass were run. The smoke pass is **one large PR × five arms × one repetition (n = 1)**; it proves the harness works end to end and gives measured token counts for a cost projection. It cannot rank the models. Every candidate is **UNDETERMINED** on both modes because ground truth, large-PR recall (needs ≥ 4 PRs) and meaningful judging are unmeasured. Nothing in production changed.

What the smoke pass does show, as observations about this one PR (not findings about the models):

- All five arms completed on the first attempt, were served by the model requested on every call, and had 0 MAX_TOKENS, 0 timeouts, 0 parse failures.
- The A/A control is noisy at n = 1: BASE vs BASE2 returned 14 vs 18 findings (swarm 11 vs 16) and basic-mode recall of BASE of 0%. Any single-PR difference of that size is not evidence.
- 3.8 Flash returned far fewer swarm findings (3, and 2 at LOW) than BASE (11). This resembles the retrospective's "going quiet" pattern, but with n = 1 it is a lead to test on the full matrix, not a result.

## What ran (live calls)

| Step | Calls | Notes |
|---|---|---|
| Capability probe | 19 | `docs/eval/data/probe-2026-11-12T01-37-24-602Z.json` |
| Smoke pass: reviews | 5 reviews, 5 attempts (cap 10) | gsr #74 (20 files, large), arms BASE, BASE2, ARGON, FLASH38, FLASH38_LOW. 74 Gemini calls inside the reviews (14–16 per arm) |
| Smoke pass: judging | 16 (cap 20) | 4 comparisons × 2 modes × 2 judges (2.5 Pro; 3.8 Flash for ARGON/BASE2, Argon for the FLASH38 pairs) |
| Spend | ≈ $1.8 recorded for the five reviews (≈ $4.2 if thinking tokens are billed on top), plus a few cents for the probe and judging (judge cost not measured) | computed from recorded tokens at the PRICE_TABLE rates; Argon's rate is unverified |

Raw data: `docs/eval/data/smoke-20261112.tar.gz` (batch dir incl. manifest with per-arm resolved routing, every attempt, diffs, judge records, per-call usage records). The large full-matrix data does not exist yet.

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

Smoke batch, per candidate vs BASE (full tables with details are in the archived `report.md`):

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

Agreed judge verdicts (n = 1 pair per cell; two judges): swarm: ARGON, FLASH38, FLASH38_LOW each "win" over BASE (both judges agree), BASE2-vs-BASE judges disagree; basic: judges disagree for every candidate and for BASE2. That the A/A control already draws a split verdict in both modes is the point: single verdicts are noise.

## Cost (measured tokens, this one 42 KB-patch review; today / after the price change)

| Arm | Cost/review today | From 2026-12-01 | From 2027-01-01 | If thinking billed on top (today) | Review wall-clock |
|---|---|---|---|---|---|
| BASE (3.1 Pro) | $0.43 | $0.43 | $0.43 | +$1.18 | 226 s |
| BASE2 | $0.44 | $0.44 | $0.44 | +$0.96 | 226 s |
| ARGON (**price unverified**) | $0.63 | $1.27 | $1.27 | +$0.06 | 151 s |
| FLASH38 | $0.15 | $0.15 | $0.30 | +$0.20 | 211 s |
| FLASH38_LOW | $0.14 | $0.14 | $0.27 | +$0.01 | 33 s |

Argon costs more per review than 3.1 Pro on recorded tokens even today (it wrote 27k output tokens vs 9k) and 3× more after 2026-12-01, unless 3.1 Pro's thinking is billed on top, in which case today's order flips. Latency is from one run at 5-way concurrency; do not compare it with any other batch.

### Projection for the full matrix (not run)

Full matrix = 23 PRs (total patch 1,066 KB = 25.4× the smoke PR) × 5 arms × 2 reps = 230 reviews, then 736 judge calls. Scaling the measured per-review tokens linearly by patch size (an upper-leaning assumption: outputs and thinking grow slower than diffs; the fixed per-call prompt is small):

| | Reviews (recorded basis) | Reviews (thinking billed on top) |
|---|---|---|
| Today's rates | ≈ $91 | ≈ $213 |
| After 2026-12-01 (Argon $4/$20) | ≈ $123 | ≈ $245 |

Judging: ≈ $30–50 (**unmeasured estimate**: ~8k input + ~3k output/thinking per call). **Total ≈ $120–300, wall-clock ≈ 3–4 hours** (≈ 4 min per (PR, rep) × 46, arms in parallel). Because the cap was blank this was not run. To run it: `compare-arms.ts … --live --max-review-calls 250`, then `EVAL_MAX_JUDGE_CALLS=800 judge-batch.ts`, then `report.ts` (commands in `tools/eval/README.md`). **Prerequisite for any ground-truth result:** attach `weitzer-org/gemini-cli-fork` (and `job_tracker`) to the session.

## Recommendation per mode

- **Basic and swarm: undetermined. Do not switch the default model on this evidence.**
- Leads for the full run, no more: (1) 3.8 Flash may under-report on large PRs in swarm mode (3 vs 11 findings); (2) FLASH38_LOW is ~7× faster and ~3× cheaper but reported the fewest findings; (3) Argon is the only arm that matched BASE's swarm finding volume (20 vs 11) but at higher cost; (4) 3.1 Pro's thinking cost may be materially under-billed in `usage.ts`, which affects every cost comparison involving it.

## What wasn't tested

Everything in the plan's §13, plus: any ground-truth PR; any PR other than gsr #74; repetitions > 1; small PRs; the 10 additional large PRs; retries (no attempt failed); Argon's real price; production reachability of the Fly URL (blocked here); the localization arm.

## Deviations from the plan

- The capability probe and smoke judging were run under the smoke authorization (plan D14). Smoke judging was not in the plan's list but exercises the judge path the report needs (16 calls).
- Before the live run, storage redirection (`nullS3.ts`) was added after finding the environment's real-bucket credentials (see Integrity). The smoke batch's `manifest.json` records `dirty tree` because that commit was made after the batch; the committed code is the code that ran.
- Early in the session, a few backend test runs were made with a bare `jest` (no `--experimental-vm-modules`) in a shell that holds those real S3 credentials; unmocked suites may have attempted usage-record writes to that bucket. I cannot tell whether any succeeded.

## Verifier

(see below)
