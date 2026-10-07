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

---

# Follow-up: which change does the work, and a held-out set

Two questions left open above: v2 changed two things at once (the prompt rule and the whole-package bundle), and the 16 findings were the ones the rule was written against. Reproduce every table below with `ts-node witness-spike/author-report.ts <label=prefix[,prefix]> ...` (it prints the files each arm pooled; check them, because a prefix such as `author-v2` also matches `author-v2-ruleonly-*`).

## 1. Decomposition on the original 16 findings (3 samples per finding per run)
`--prompt` and `--bundle` are independent in `author-bench.ts`, so each factor was run on its own.

| Arm | Prompt | Bundle | Runs | Proven | Wrong "proven" | Wrongly refuted |
|---|---|---|---|---|---|---|
| baseline (v1) | v1 | single file | 3 | 77 | **14** | 0 |
| bundle-only | v1 | whole package | 2 | 46 | **5** | 0 |
| rule-only | v2 | single file | 2 | 42 | **0** | 0 |
| full v2 | v2 | whole package | 2 | 43 | **1** | 0 |

- The prompt rule is what removes the false proofs. With the single-file bundle it gave 0 wrong of 42, and adding the whole-package bundle on top did not help (1 of 43, within noise).
- The whole-package bundle on its own fixed one of the two failing findings and not the other. `go-fake-too-loose` went to 0 wrong once the author could see the package's context-aware fake, but job_tracker's `Store.Mutate` stayed wrong in 5 of 6 samples: there the only existing double (`storage.MemoryClient`) itself ignores `ctx`, so showing it does not help.
- Cost per call from the cache-aware runs only (the earlier runs predate the cache fix and are overstated, so they are not compared): v1 $0.0094, rule-only $0.0110, bundle-only $0.0140, full v2 $0.0141. The rule is cheap; most of v2's extra cost is the bundle, which on this evidence buys nothing measurable.
- Caveat that still applies: the rule was written after seeing v1 fail on these same findings, so 0 of 42 is an in-sample result.

## 2. Held-out set (13 cases, never used to tune the prompts)
The cases live in `fixtures/witness-heldout/cases/` and the labels in `witness-spike/heldout-truth.json`, committed (039a812) before any held-out run. Contents: 6 true findings (a true ctx bug and a true contract bug, both with a contract-honouring package double, plus a nil-map panic, an off-by-one, a bug in code new in the PR, and a JavaScript regression), 6 false findings (3 deliberate traps where a loose double produces a false proof: a package double that ignores `ctx` and says so, a duplicate-free `Lister` contract, and a memoizer whose documented behaviour is that errors are not cached; plus 3 plain false findings, one in JavaScript) and 1 opinion. Every label was checked by running code, then re-derived independently by a second reviewer; that review found one arguable case (`go-contract-sorted-false`: its finding named an input that violates the contract), which was redesigned before any author run. Each trap was confirmed by executing a loose witness through the real pipeline: it is wrongly proven.

Metrics were fixed in advance: wrong "proven" on the false/opinion cases and wrongly refuted on the true cases, per case, with no pooled significance claim.

All four arms, 2 runs x 3 samples per finding (78 samples each), 0 author failures, 0 Docker errors:

| Arm | Proven | Wrong "proven" | Wrongly refuted | Declined on a behavioural finding |
|---|---|---|---|---|
| v1, single file | 36 | 0 | 0 | 2 |
| v1, whole package | 36 | 0 | 0 | 0 |
| v2 rule, single file | 36 | 0 | 0 | 0 |
| v2 rule, whole package | 36 | 0 | 0 | 0 |

Per case, every arm returned the same verdict in all 6 samples, with two exceptions: `go-memo-error-path-false` under v1 with a single file (4 refuted, 2 declined). The three traps were never fallen into (18 of 18 refuted in every arm), including v1 with the whole package, which was shown the non-compliant `MemStore` and did not reuse it.

**What this establishes, and what it does not.**
- It closes one open gap: v2's rule does not make the author refute or abandon a TRUE ctx or contract bug (12 of 12 samples of the two such cases proven in each v2 arm, no wrongly refuted finding anywhere).
- It does not show v2 is better than v1. The set does not discriminate: v1 produced no false proof on it either. So the v1 false proofs are not a general weakness against every contract trap; they showed up where building a faithful double is costly (a storage client with many methods, a struct with several dependencies), and the small synthetic interfaces here made an honest double easy to write. That explanation is a hypothesis; this set was not built to test it.
- Known limits of the set: the plain cases saturate (every arm gets them right every time), eight cases have an empty base-to-head diff, and the whole set is synthetic. A harder and more realistic held-out set needs real findings from real PRs, with labels from human outcomes, not cases written to fit the failure mode.

## 3. Updated recommendation
- Adopt the v2 prompt rule. It removed the false proofs on every set where v1 produced any, did not cause false refutations or declines on true bugs, and costs about 17% more per call than v1.
- Do not adopt the whole-package bundle on this evidence. It adds cost, up to 1.5x per call, and did not change any outcome the rule did not already change. Revisit it if a real finding turns out to need a double that is only visible in another file.
- Before treating either as a measured safety property: build the realistic held-out set from real PRs (the v1 failure appeared on real job_tracker code and did not appear on small synthetic traps), and keep `refuted` collapse-never-drop.
