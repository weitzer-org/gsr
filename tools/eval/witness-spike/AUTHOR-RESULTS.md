# Gemini witness author: measured results

Model `gemini-3.1-pro-preview`, default temperature, 16 findings (12 testbed cases + 4 job_tracker `must_catch`) x 3 samples = 48 author calls per run. Truth labels: `author-truth.json`, fixed before the runs. Raw samples: `../fixtures/witness-author-runs/`. Reproduce: `npx ts-node witness-spike/author-bench.ts --prompt v1|v2 --n 3`.

The testbed has 12 cases and 13 reference checks (`go-fake-too-loose` has a second, deliberately loose reference witness). The author writes one witness per case, so the author runs use 12 testbed findings, not 13.

| | v1 (original) | v1 (rerun) | v2 |
|---|---|---|---|
| Samples / findings | 48 / 16 | 48 / 16 | 48 / 16 |
| proven verdicts | 25 | 25 | 21 |
| **wrong proven (false proofs)** | **4** | **4** | **0** |
| correct refuted / false refutations | 11 / 0 | 11 / 0 | 16 / 0 |
| hypothesis or opinion on a behavioral finding | 6 | 6 | 5 |
| yield (proven or refuted) | 0.75 | 0.75 | 0.77 |
| cost per call, thinking not billed | $0.0099 | $0.0098 | $0.0204 |
| cost per call, thinking billed as output (unverified assumption) | $0.0397 | $0.0349 | $0.0519 |

Cost is per author call (one witness attempt). Multiply by 3 for a finding at n=3. Whether Gemini bills thinking tokens as output could not be checked (pricing page blocked), so both columns are shown. v2 costs about 2.1x v1 per call (1.5x with thinking billed), almost all from the larger input on the job_tracker entries (whole-package source).

Local usage-store writes are not recorded here (no MinIO/R2 or ingest secret in this environment); per-call tokens and cost are in each sample's `usage`.

## Wrong "proven" verdicts
All 8 (4 per v1 run) come from two findings, and all use a self-written test double that ignores `ctx`:
- `go-fake-too-loose` (testbed): 1 of 3 samples in each v1 run. v1 never saw the package's ctx-aware `MemReader`.
- `recruiter-store-mutate-missing-ctx-done` (job_tracker): 3 of 3 in each v1 run. With the real S3 client a cancelled context makes no request and `Mutate` stops on the first read (reproduced), so the finding is false for real clients.

v2 produced none: `go-fake-too-loose` is refuted 3/3 using the package `MemReader`, and `recruiter` is refuted 3/3 using self-written doubles that honour ctx (the package's own `MemoryClient` ignores ctx, so for recruiter the contract rule, not the reuse rule, did the work).

## Per-case verdicts (v1 rerun / v2; P=proven_regression, PP=proven_preexisting, R=refuted, H=hypothesis, O=opinion)
Every case returned the same verdict 3/3 in both prompts except: `go-fake-too-loose` v1 PP,R,R / v2 R,R,R; `recruiter` v1 P,P,P / v2 R,R,R; `go-timeout` v1 H,H,H / v2 H,H,R. Both prompts: all true findings proven 3/3 (`go-regression`, `go-new-code`, `go-build-failure`, `js-regression`, `go-preexisting` as PP, `filters-containsAny...`, `filters-containsAnyWord...` weak label), opinions abstain, false findings refuted.

## What this does and does not show
- Not statistically significant: 0/21 vs 4/25 wrong among proven, Fisher two-sided p = 0.11 (one-sided 0.08); counted by finding (2 discordant findings) the sign test gives p = 0.25. Samples are not independent, and the two findings are near-duplicates (the testbed case was built to mirror the recruiter false proof).
- In-sample: the v2 rule was written after seeing v1 fail on these same findings and names the failure mode (ctx cancellation). It is a fix for a known failure, not evidence of generalisation.
- Confounded: v2 changes the bundle (whole-package source) and the prompt rule together. For `go-fake-too-loose` the bundle alone could explain the fix; for recruiter only the rule can.
- Unmeasured: no case has a *true* ctx/contract bug, so v2's false-refutation rate on real ones is unknown (it tells the model a contract-honouring witness "will then pass", which pushes toward refuting). Some v2 refutations rest on weak assertions (e.g. `go-timeout` v2 #2 only calls `Page` once with no assertion).
- `containsAnyWord` carries a weak label; its proofs are right for the multi-word-needle boundary bug, not for the punctuation-needle story in the finding.
- Sandbox limits from Phase 0 still apply: a hostile package can forge a pass, a refuted verdict must collapse a finding and never drop it, and the Jest runner is unsandboxed (here guarded only by a static deny-list; trusted fixtures only).
