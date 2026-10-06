# Gemini witness author: measured results

Model `gemini-3.1-pro-preview`, default temperature, 16 findings (12 testbed cases + 4 job_tracker `must_catch`) x 3 samples = 48 author calls per run. Truth labels: `author-truth.json`, fixed before the runs. Raw samples: `../fixtures/witness-author-runs/`. Reproduce: `npx ts-node witness-spike/author-bench.ts --prompt v1|v2 --n 3`.

The testbed has 12 cases and 13 reference checks (`go-fake-too-loose` has a second, deliberately loose reference witness). The author writes one witness per case, so the author runs use 12 testbed findings, not 13.

| | v1 run 1 (orig. prompt) | v1 run 2 | v1 run 3 | v2 run 1 | v2 run 2 |
|---|---|---|---|---|---|
| Samples / findings | 48 / 16 | 48 / 16 | 48 / 16 | 48 / 16 | 48 / 16 |
| proven verdicts | 25 | 25 | 27 | 21 | 22 |
| **wrong proven (false proofs)** | **4** | **4** | **6** | **0** | **1** |
| correct refuted / false refutations | 11 / 0 | 11 / 0 | 8 / 0 | 16 / 0 | 14 / 0 |
| hypothesis or opinion on a behavioral finding | 6 | 6 | 7 | 5 | 6 |
| cost per call, cache-aware, thinking not billed | n/a (not cache-aware) | n/a | $0.0094 | n/a | $0.0141 |
| cost per call, cache-aware, thinking billed (unverified assumption) | n/a | n/a | $0.0427 | n/a | $0.0412 |

**Pooled over valid runs: v1 14 wrong of 77 proven (18%); v2 1 wrong of 43 proven (2%).** Fisher two-sided p = 0.010 counting samples as independent, which they are not (see below).

Run 1 and 2 of each prompt predate the cache-aware cost fix, so their cost columns are not comparable and are omitted. Run 1 of v1 is the original prompt, before a leaked example symbol was removed; runs 2 and later use the fixed prompt. Runs 3 (v1) and 2 (v2) used the benchmark after the review fixes (cache-aware cost, witness bound to its finding's file and language). An earlier attempt at those two runs was discarded because the Docker daemon had died mid-run and most Go runs returned `not_run`; the harness now refuses to start without Docker.

Cost is per author call; multiply by 3 for a finding at n=3. Gemini's implicit cache served 4.8% of v1 prompt tokens and 35.9% of v2's on those runs (repeat prompts across the n=3 samples). The cost convention (`tools/eval/usage.ts`) treats cached input as free, a lower bound; whether Gemini discounts rather than zeroes cached tokens, and whether thinking tokens bill as output, are unverified. With thinking billed, v1 and v2 cost about the same per call; without it v2 is about 1.5x.

Local usage-store writes are not recorded here (no MinIO/R2 or ingest secret in this environment); per-call tokens and cost are in each sample's `usage`.

## Wrong "proven" verdicts
v1: 14 across three runs, all from two findings, all using a self-written test double that ignores `ctx`:
- `go-fake-too-loose` (testbed): 1 of 3 samples in runs 1 and 2, 3 of 3 in run 3. v1 never saw the package's ctx-aware `MemReader`.
- `recruiter-store-mutate-missing-ctx-done` (job_tracker): 3 of 3 in every run. With the real S3 client a cancelled context makes no request and `Mutate` stops on the first read (reproduced), so the finding is false for real clients.

v2: 1 across two runs. `go-fake-too-loose` is refuted 6 of 6 using the package `MemReader`. `recruiter` is refuted 5 of 6; the miss (run 2, sample 1) is the same failure mode: a self-written storage fake whose `ReadFile` ignores `ctx` and whose `WriteFile` cancels the context itself, then asserts at most one write. v2 reduces the failure but does not eliminate it. The package's own `MemoryClient` ignores ctx, so for recruiter only the contract rule, not the reuse rule, can help.

## Per-case verdicts (P=proven_regression, PP=proven_preexisting, R=refuted, H=hypothesis, O=opinion)
Stable across every run and both prompts (3/3 each time): all true findings are proven (`go-regression`, `go-new-code`, `go-build-failure`, `js-regression`, `go-preexisting` as PP, `filters-containsAny...`, `filters-containsAnyWord...` with a weak label); `go-opinion` and `scoring-fallback-judge-passthrough` are declined as opinions; `go-refuted-false-finding` and `js-refuted-false-finding` are refuted. No run, in either prompt, ever refuted a true finding.
The ones that move: `go-fake-too-loose` (v1 1-3 of 3 wrongly proven per run; v2 R,R,R both runs), `recruiter-store-mutate-missing-ctx-done` (v1 P,P,P every run; v2 R,R,R then R,P,R), and the noise-level cases `go-timeout`, `go-setup-skip` and `js-setup-failure`, which flip between R, H and O across runs without ever reaching a proven verdict.

## What this does and does not show
- Pooled, v1 14/77 vs v2 1/43 wrong among proven, Fisher two-sided p = 0.010 treating samples as independent. They are not: every wrong proof comes from two findings, which are near-duplicates (the testbed case was built to mirror the recruiter false proof). Counted by finding, only two findings differ, so this is strong evidence about one failure mode, not about the rate on new findings.
- In-sample: the v2 rule was written after seeing v1 fail on these same findings and names the failure mode (ctx cancellation). It is a fix for a known failure, not evidence of generalisation.
- Confounded: v2 changes the bundle (whole-package source) and the prompt rule together. For `go-fake-too-loose` the bundle alone could explain the fix; for recruiter only the rule can.
- Unmeasured: no case has a *true* ctx/contract bug, so v2's false-refutation rate on real ones is unknown (it tells the model a contract-honouring witness "will then pass", which pushes toward refuting). Some v2 refutations rest on weak assertions (e.g. `go-timeout` v2 #2 only calls `Page` once with no assertion).
- `containsAnyWord` carries a weak label; its proofs are right for the multi-word-needle boundary bug, not for the punctuation-needle story in the finding.
- Sandbox limits from Phase 0 still apply: a hostile package can forge a pass, a refuted verdict must collapse a finding and never drop it, and the Jest runner is unsandboxed (here guarded only by a static deny-list; trusted fixtures only).
