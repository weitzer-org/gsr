# Gemini 4 upgrade plan for GSR

Status (2026-11-05): inventory done; served-model tracking, the Argon price
row and the thinking-token billing fix shipped; plan steps 1-2 (billing
check, capability probe) run, 22 calls, about $0.17. Steps 3 onward have not
started. Each paid step needs the owner's go-ahead first.

Inputs:

- The lessons from sound-profile-builder's move to `gemini-4-argon`
  (appendix A, kept verbatim). Its "Suggested plan" was written without
  looking at GSR. Section 2 below corrects it against GSR's code.
- GSR's own earlier flash-model investigation,
  [gemini-flash-model-investigation.md](gemini-flash-model-investigation.md).
  Read it before running any comparison. Its benchmark (13 PRs, deterministic
  `computeRecall`, position-randomised judge) is the starting point, and its
  list of methodology bugs is the list of traps.

## 1. Inventory (confirmed against the code on `main`, 65dc570)

Every production Gemini call goes through `trackGeminiCall`
(`adk/backend/src/usage.ts`). Nothing sets `maxOutputTokens`, and nothing
sets `thinkingLevel`. GSR has no model fallback chain: a failed call is
caught and degrades to "no findings" (agents), "raw findings" (dedup),
"neutral"/"unclear" (feedback), or a fixed string (evaluator).

| callType | Where | Model (env, default) | Response schema | Thinking / output cap | Role |
| --- | --- | --- | --- | --- | --- |
| `discovery` | `agent.ts` pass 1, once per persona per PR (chunks aggregated) | `GEMINI_MODEL`, `gemini-3.1-pro-preview` | `{filesAnalyzed[], issues[{file, line: INTEGER, severity enum, summary}]}`, all required | default / none. Context cache (`caches.create`) is keyed on the same model | Recall-critical: decides what gets reported at all |
| `remediation` | `agent.ts` pass 2 | `GEMINI_MODEL` | `[{file, line: INTEGER, severity, summary, description, suggestion}]`, all required | default / none | Synthesis (long free text) |
| `legacy` | `agent.ts`, only with `USE_TRIAGE_AGENT=false` | `GEMINI_MODEL` | as remediation, `suggestion` optional | default / none | Synthesis (off by default) |
| `deduplicate` | `deduplicator.ts` | `DEDUPLICATOR_MODEL`, `gemini-3.1-pro-preview` | `[{file, line: INTEGER, severity, summary, description, suggestion?, agent?}]` | `thinkingBudget: 4096` (works around a hang; 3.1 Pro rejects 0) | Merges **and rewrites** text, so synthesis, not narrow |
| `evaluate` | `evaluator.ts` (UI's basic-vs-swarm summary) | `GEMINI_MODEL` | none (Markdown, "under 250 words") | default / none | Short synthesis |
| `feedback_classify` | `adjudicator.ts` | `FEEDBACK_MODEL`, else `GEMINI_MODEL` | `[{commentId: INTEGER, stance enum, confidence: NUMBER}]`, all required | default / none | Narrow (classification) |
| `feedback_adjudicate` | `adjudicator.ts` | `FEEDBACK_MODEL`, else `GEMINI_MODEL` | `{verdict enum, confidence: NUMBER, reasoning, rebuttalMarkdown}`, all required | default / none | Synthesis; posts publicly |
| judge | `tools/eval/llm-comparator*.ts` | hard-coded `gemini-2.5-pro` | prompt-specified JSON | default | Eval only |
| witness author | `tools/eval/witness-spike/author.ts` | `WITNESS_AUTHOR_MODEL`, `gemini-3.1-pro-preview` | see file | default | Eval/spike only |

Personas: ten prompts in `adk/prompts/system_prompts/` (architecture, cicd,
dependencies, logic, performance, promptsecurity, secrets, security,
techdebt, testing), plus `system_prompts_v2/` and the single `basic_prompt`.
That is ten subagents, not the five the lessons assumed. Every persona runs
the same two calls (discovery, remediation) on the same model, so routing is
per **call type**, not per persona, unless `agent.ts` grows a per-persona
model setting.

The GitHub Action exposes only `gemini-model` (sets `GEMINI_MODEL`).
`DEDUPLICATOR_MODEL` and `FEEDBACK_MODEL` are not Action inputs, so a
consumer repo can't route them separately today.

## 2. Where the lessons don't transfer as written

- **"Discovery is narrow, so 3.8 Flash at LOW" is contradicted by GSR's own
  data.** The flash investigation found flash-tier discovery recovered only
  28-31% of the baseline's findings on the three large PRs, and ~88% on small
  ones. That was 3.5-3.7 Flash, not 3.8 Flash at LOW, so it isn't a verdict on
  3.8. But discovery must be measured on recall, not assumed narrow.
- **The deduplicator is synthesis, not narrow.** It rewrites `description`
  and `suggestion` for every merged group. It also has a known collapse
  failure mode (`deduplicator-duplication-bug.md`). Treat it as a candidate
  for Argon, not for Flash.
- **"Make whole numbers INTEGER" is already done.** `line` and `commentId` are
  `INTEGER` everywhere. The two `NUMBER` fields left are `confidence`
  (0..1, fractional by design, so it can't become `INTEGER` without changing
  its meaning). Watch them for the runaway-decimal truncation the lessons
  describe (`MAX_TOKENS` on `feedback_*` calls), and switch to an integer
  0-100 scale only if it shows up.
- **"Make must-have fields required" is already done** on every schema
  above. The free-text fields (`description`, `suggestion`, `reasoning`,
  `rebuttalMarkdown`) are unbounded in both schema and prompt. The lessons
  say a schema `maxLength` is not enforced, so any bound goes in the prompt.
- **"Eval-only no-fallback flag" doesn't apply.** There is no fallback chain.
  The GSR equivalent is the silent degradation above: an eval run in which
  any call failed must be marked unscoreable, from the usage records
  (`success: false`), not inferred from the findings.
- **`thinkingBudget` on the deduplicator.** The lessons found budgets
  unreliable and `thinkingLevel` the working control. The 4096 budget is a
  hang workaround specific to 3.1 Pro. Argon and 3.8 Flash both accept it
  (§5), but if `DEDUPLICATOR_MODEL` moves to either, re-test that hang on
  repetitive input and prefer `thinkingLevel`. The SDK pinned here
  (`@google/genai` 1.45.0) has `thinkingLevel` (`ThinkingLevel` enum).
- **Context caching doesn't apply.** `gemini-4-argon` doesn't list
  `createCachedContent` among its supported methods (the models list
  endpoint, 2026-11-05). That doesn't matter today: every persona prompt is
  about 400 tokens and `basic.md` about 1,100, below `agent.ts`'s
  2,048-token threshold, so production never creates a cache.

## 3. What shipped with this doc

- **Served model on every usage record.** `trackGeminiCall` and
  `recordParseFailure` now store `servedModel` (from
  `response.modelVersion`) whenever it differs from the requested id. The
  lessons found `gemini-3.5-flash` served as `gemini-3.6-flash` on every
  call, and `gemini-pro-latest` resolving to `gemini-3.1-pro-preview`. Any
  record carrying `servedModel` was not served by the model it names.
  sound-profile-builder's captured runs show the field comes back as the bare
  id (`gemini-3.6-flash`, `gemini-4-argon`, ...; ~4,000 records under its
  `eval_results/`), so it stays absent in the normal case.
- **`gemini-4-argon` in `PRICE_TABLE`**: $2 / $10 through 2026-11-30, then
  $4 / $20, via the existing `supersededBy` mechanism. Same rates as
  sound-profile-builder. Not yet checked against the Gemini Developer API
  pricing page (ai.google.dev), which the proxy blocks here. The third copy
  (`job_tracker`'s `pricing.go`) was not touched from this repo.
  `tools/eval/usage.ts` only prices models that service calls, so it gets the
  row when a judge or author moves to Argon. Google Cloud's pricing page
  (read 2026-11-05) shows the same Argon rates.
- **Thinking tokens billed at the output rate** in both `usage.ts` copies
  (§4). Stored records were not repriced.
- **`tools/eval/model-probe.ts`**: the capability probe for §5. Dry run by
  default; `--run` makes the calls and writes the full responses, raw text
  included, to `tools/eval/model-probe-runs/`.

## 4. Thinking tokens were under-billed (fixed)

`computeCostUsd` was billing `candidatesTokenCount` only and treating
`thoughtsTokenCount` as telemetry, on the theory that candidates already
included thoughts. They don't. On all 22 probe calls (four models),
`totalTokenCount` was exactly prompt + candidates + thoughts, and
`candidatesTokenCount` matched the token count of the visible text alone
(within 1 token; a constant 15 on Argon, which looks like `countTokens`
overhead). Google Cloud's pricing page bills thoughts at the output rate
("Price per 1M output and thinking tokens"; Argon: "Text output (response
and reasoning)"). The Gemini Developer API's own page (ai.google.dev) is
blocked from this environment, so that tier rests on the rates matching.

On the probe's small inputs, the old formula under-reported
`gemini-3.1-pro-preview` by 3.8x ($0.022 vs $0.083 over five calls). Real
PRs have far larger inputs, so the gap there is smaller, but it wasn't
measured. Records written before the fix keep their old `costUsd`; they
still carry `thinkingTokens`, so they can be repriced at query time.
GSR now bills the same way as sound-profile-builder (TODO 42).

## 5. Capability probe results (2026-11-05)

`tools/eval/model-probe.ts --run`, 22 calls; raw output in
`tools/eval/model-probe-runs/model-probe-2026-11-05.json`. The input was two
one-line seeded bugs from the witness testbed (`go-regression`,
`js-regression`), with GSR's exact schemas and system instructions. It shows
what each model accepts and how it bills, **not** review quality: every
model found both bugs, which a two-line diff can't tell apart.

| Model | Calls | Served as | Finish | Schema-valid | Median latency | Thinking tokens (default) |
| --- | --- | --- | --- | --- | --- | --- |
| `gemini-3.1-pro-preview` (prod) | 5 | itself | 5 STOP | 5/5 | 10.9 s | 210-1,403 on every call |
| `gemini-4-argon` | 8 | itself | 8 STOP | 8/8 | 7.2 s | 144-183 on discovery; 0 on remediation, dedup, classify |
| `gemini-3.8-flash` | 8 | itself | 8 STOP | 8/8 | 8.0 s | 172-909 on every call |
| `gemini-2.5-pro` (eval judge) | 1 | itself | STOP | 1/1 | 6.2 s | 414 |

What it established:

- **Every request shape works on both candidates.** Discovery (logic and
  basic prompts), remediation, dedup and feedback classification all came
  back schema-valid with `STOP`. `thinkingBudget: 4096` (the dedup setting)
  is accepted by Argon and 3.8 Flash, with no 400. `thinkingLevel` LOW and
  HIGH are accepted by both.
- **`thinkingLevel: LOW` works as a control.** Argon discovery: 144
  thinking tokens at default, 0 at LOW. 3.8 Flash discovery: 909 at
  default, 0 at LOW; dedup 775 at default, 277 at LOW. HIGH raised them
  (Argon 576, 3.8 Flash 2,080) without a timeout on these small inputs.
- **Argon does think at default on discovery.** The lessons saw 0 thinking
  on every agent. Here it was 0 everywhere except discovery (144-183).
- **Argon counts more input tokens for the same request**: 267-393 more
  than 3.8 Flash and 3.1 Pro on identical prompts (1.3-1.5x at these sizes).
  The gap looks closer to a fixed per-request amount than a proportional
  one, but these inputs are too small to tell. Measure it on a real PR
  before comparing costs: at a 1.5x ratio, Argon's input would cost more
  than 3.1 Pro's at the same $2/1M rate.
- **No served-model surprises.** Every id GSR sends today
  (`gemini-3.1-pro-preview`, `gemini-2.5-pro`) and both candidates were
  served as requested. `gemini-pro-latest` (not used by GSR) is listed as a
  separate model; the lessons found it resolves to 3.1 Pro.
- **`confidence` (NUMBER) behaved.** Values came back as 0.95-1, with no
  runaway decimals.

## 6. Plan

Each step names its cost. Steps marked **paid** need the owner's go-ahead.

1. ~~**Verify the thinking-token billing.**~~ Done (§4); the formula is fixed.
2. ~~**Probe capabilities.**~~ Done (§5), 22 calls. Caching didn't need a
   probe (§2).
3. **Ground truth.** Free. Reuse the flash investigation's 13-PR benchmark
   and `computeRecall`. Add precision: label the baseline's findings on the
   10 seeded-bug PRs as true/false positive once, so candidates are scored by
   machine.
4. **Screen per call type on frozen inputs.** Paid, small. Capture the exact
   discovery, remediation and dedup inputs from one baseline review per
   benchmark PR, then replay only that call per candidate model. Gate on
   schema validity, `MAX_TOKENS` rate and recall. `model-probe.ts` already
   sends the exact request shapes and keeps raw text; it needs a way to load
   captured inputs instead of its built-in fixtures. Also record input
   tokens per model on these real inputs (§5, Argon's extra input tokens).
5. **End to end.** Paid, the bulk of the spend. Full reviews in one batch,
   baseline included, 2+ reps; n >= 20 on any rare defect such as dedup
   collapse or truncation. Mark any run with a failed call or a
   `servedModel` record unscoreable.
6. **Judge.** Add a second neutral judge next to `gemini-2.5-pro` (not a
   contestant), keep the position randomisation, count only verdicts both
   agree on, and spot-check every verdict that cites a line.
7. **Route.** Start from: Argon for remediation, dedup and adjudicate;
   discovery decided by step 4's recall numbers, not by role; 3.8 Flash at
   LOW for `feedback_classify` if it matches on agreement with the baseline.
   This needs per-call-type model settings (`REMEDIATION_MODEL` alongside
   `GEMINI_MODEL`) and matching Action inputs. Not built yet.
8. **Watch after deploy.** One week of served model, `MAX_TOKENS` rate,
   p95 latency (Argon has 60-90 s stalls; the 300 s `GEMINI_TIMEOUT_MS`
   covers them) and cost per review from the usage dashboard.

Deadlines: Argon's rate doubles on 2026-12-01 and 3.8 Flash's on
2027-01-01. Run the paid steps before 2026-12-01 to get them at half price.

---

## Appendix A: Gemini upgrade lessons from sound-profile-builder (2026-11-05, verbatim)

### Model facts we verified

Every row was observed in live calls (Gemini Developer API, genai Go SDK v1.63) on 2026-11-04/05. Prices are standard tier, global endpoint, per 1M tokens; output includes thinking tokens.

| Model id | Served as | Price in / out | Thinking at default | Notes |
| --- | --- | --- | --- | --- |
| `gemini-4-argon` | itself | $2 / $10 through 2026-11-30, then **$4 / $20** | 0 tokens on every agent | 32,768 max output; occasional 60-90 s server stalls on tiny replies; with `ThinkingLevel: HIGH` it hit 504 timeouts |
| `gemini-3.8-flash` | itself | $0.75 / $3.75 through 2026-12-31, then $1.50 / $7.50 | 350-3,300 tokens per call | Thinking can run away to ~15,360 tokens and truncate |
| `gemini-3.5-flash` | **`gemini-3.6-flash`** (7 of 7 calls) | $1.50 / $9.00 | ~1,000 tokens | Being deprecated; the id silently aliases 3.6 |
| `gemini-3.6-flash` | itself | $0.75 / $3.75 through 2026-12-31 | ~1,000 tokens | |
| `gemini-3.1-pro-preview` | itself | $2 / $12 (<=200K prompt) | ~4,600 tokens on a long synthesis prompt | Rejects `ThinkingBudget: 0` (400) |
| `gemini-pro-latest` | `gemini-3.1-pro-preview` | alias | | Not a newer model |
| `gemini-3.5-flash-lite` | itself | $0.30 / $2.50 | 0 | Rejects `ThinkingBudget: 0` (400) |

- **MaxOutputTokens counts thinking.** A tight cap can return empty or truncated output with `MAX_TOKENS`.
- **`ThinkingLevel` (MINIMAL/LOW/MEDIUM/HIGH) is the control that works.** `ThinkingBudget` is not a reliable cap: 512 cut 3.8 Flash's thinking to 0, but 8,192 did not stop a 15,361-token runaway.
- **Google Search grounding** is billed per query: 5,000 a month free across Gemini 3 and 4, then $14 per 1,000. Input tokens from grounding are free.

### Failure modes we hit, and the fix

All of these were root-caused from captured raw responses. The orchestrator discards the text of a truncated response, so we built a probe that keeps it. Do the same before you diagnose a truncation.

| Symptom | Root cause | Fix that worked |
| --- | --- | --- |
| `MAX_TOKENS` on a small agent (~7,000 tokens out vs ~200 normal) | A free-text `rationale` string never closed: filler sentences, then a loop of "valid standard parseable JSON object baseline output format" | A short-rationale rule in the prompt, and routing to Argon (0 loops in 58 calls). A schema `maxLength` is accepted but **not enforced** (701-1,771 chars came back against 400) |
| `MAX_TOKENS` on a numeric-output agent (~3,000-4,000 tokens) | A `NUMBER` field written as `85.0000000…` until the cap | Type whole-number fields as `INTEGER`. Loops went 17/26 -> 0/26 on Argon and 3/26 -> 0/26 on 3.8 Flash |
| Required content missing (one of two objects, an optional number) | Fields were optional in the schema; "MUST output both" in the prompt was ignored 2-4 times in 6 | Mark them `required` in the response schema. 12/12 complete after |
| 3.8 Flash truncates on the long synthesis agent | Thinking ran to ~15,360 of 16,000 tokens | `ThinkingLevel: LOW` (0 in 26 runs); a budget did not help |
| Agents told to use Google Search almost never did (0/26 calls on two agents) | Search is the model's choice per call; it skips it when it thinks it knows the answer | Nothing in the prompt or schema forced it: removing the schema, "search first", and a required `sources` field all failed, and `sources` made models **invent** grounding-redirect URLs. The SDK has no force option. Argon searches more readily than 3.8 Flash |
| Wrong units copied from upstream agents | Upstream prompts phrased values in a unit the final agent must not use, and told the next agent to copy them "strictly" | Fix the wording at the source agent; add a translate rule plus a final self-check to the last agent |
| Pipeline silently scored on a different model | The fallback chain routed failures (and unknown models) to an old model | An eval-only `EVAL_NO_FALLBACK` flag; unknown models get no fallback; chains use only current models |

### Which model fits which kind of agent

Argon wins on agents that synthesize a long, judged answer. 3.8 Flash at LOW thinking matches it on narrow agents at a fraction of the time and cost. Head-to-head, same batch, 13 queries x 2 reps:

| Setup | Completed | Median / p95 time | Cost per run now / from Dec | Judged vs Argon |
| --- | --- | --- | --- | --- |
| Argon everywhere (shipped) | 26/26 | 191 / 290 s | $0.22 / $0.43 | baseline |
| Argon, `ThinkingLevel: HIGH` | 10/26 | 442 / 551 s | $0.28 / $0.56 | tie |
| 3.8 Flash everywhere, `LOW` | 26/26 | 56 / 76 s | $0.07 / $0.14 | loses 3-20 |
| 3.8 Flash everywhere, default | 24/26 | 142 / 190 s | $0.13 / $0.26 | loses 3-12 |

Times are inflated by 8 runs sharing the API, so compare rows with each other. "Judged" counts only verdicts both neutral judges agreed on.

- **The gap lives in the synthesis role.** With 3.8 Flash only upstream and a stronger model writing the final answer, outputs were as complete as Argon's. With 3.8 Flash writing the final answer, it dropped content (5.4 blocks vs 6.6, a required element missing in 40% of runs), and judges called it "generic".
- **Thinking did not buy quality on Argon.** HIGH was a judged tie, 2.3x slower, and failed 16 of 26 runs (Google-side 504s, and thinking consuming the per-agent output caps).
- **For GSR (hypothesis, not measured):** agents that weigh evidence and write findings (Architecture, Logic, Security) look like our synthesis role, so Argon there. Agents that classify, extract or deduplicate look like the narrow roles where 3.8 Flash at LOW was enough. Measure before routing.

### Evaluation method that held up

Machine checks decide; LLM judges only break ties, and every judge claim we acted on was spot-checked against the files.

1. **Record the served model on every call.** Store `GenerateContentResponse.ModelVersion`, finish reason, tokens, latency and a `grounded` flag per attempt. Mark any run where an attempt failed, fell back, or was served by a different model as unscoreable.
2. **Run evals with fallback off.** An env flag makes the fallback chain return nil, so a failing candidate fails visibly.
3. **Screen single agents first, cheaply.** Agents whose input is just the user request can be tested alone across all queries for schema validity, truncation and grounding rate, before any full pipeline.
4. **Freeze upstream to isolate one agent.** Run the pipeline once on baseline models, capture the exact prompt the target agent receives, then replay only that agent per candidate. Every candidate sees identical input, and prompt changes can be A/B tested for a few dollars.
5. **Gate on deterministic, ground-truth checks.** Validate output against the exact response schema you send, and count domain defects against your own reference data, not an LLM's opinion.
6. **Judge with four models, in randomized order.** Use two neutral judges that aren't contestants, plus each contestant. Count only verdicts both neutral judges agree on, and check whether contestant judges favour themselves. Ours didn't: 3.8 Flash preferred Argon's output 17-9.
7. **Strip each pipeline's own self-critique before judging.** Otherwise a quieter critic makes its outputs look cleaner for the wrong reason.
8. **Same batch, same prompts, n >= 20 for rare defects.** Five reps per arm said "no difference" (p = 0.17); twenty showed 15% vs 95% (p < 0.001).
9. **Gate spend.** Every tool defaults to `-dry-run` and prints the exact call count, plus a smoke pass before each full grid.

### Mistakes to avoid

- **Blaming the model for a prompt defect.** The newer models looked far worse on one rule (95% vs 15% defect rate) until we found our own prompt's only example showed the wrong format. The production model had the same defect in 19 of 20 runs; it just hid it by omitting the field. After the prompt fix, all models were clean.
- **Trusting a narrow checker.** Our defect counter looked at 5 parameter names and one unit, so it reported 3/20 where the real rate was 19/20. Widen checks before concluding a model is clean, and look for false positives.
- **Assuming the baseline passes.** A "control must pass" gate only works if the control is defect-free. Measure its rate and compare candidates against that, not against zero.
- **Trusting the model id.** One stable id silently served a newer model, and a "-latest" alias pointed at an existing model.
- **Assuming a config knob works.** A thinking budget, a schema `maxLength` and "MUST" instructions were all accepted and all ignored at least some of the time. Verify each control with a live call.
- **Treating citations as proof of grounding.** Asking for source URLs produces plausible fake ones. Use the response's grounding metadata instead.
- **Comparing latency across parallel runs.** Eight concurrent pipelines raised medians from ~128 s to ~191 s, so compare arms only within one batch.
- **Missing that a PR quietly stopped being checked.** GitHub runs no `pull_request` workflows while a PR has a merge conflict; ours went ~40 pushes without CI or review until we merged `main` back in.

### Sources

- PR: https://github.com/weitzer-org/sound-profile-builder/pull/114
- Full write-up with raw numbers: `docs/eval/gemini-model-upgrade-test-plan.md` in sound-profile-builder (§4a Phase 1, §5a Phase 2, §9a production changes, §9b head-to-head); raw data under `eval_results/`.
- Reusable tools in sound-profile-builder: `cmd/probe_agent` (raw-text single-agent replay), `cmd/eval_architect` (frozen-input replay), `cmd/eval_subagent`, `cmd/eval_full_pipeline`, `cmd/eval_strip_critic`, `docs/eval/scripts/run_quality.sh` (four judges), `internal/evalcheck`.
- Follow-up issues: #122 (hybrid routing), #123 (3.8 Flash quality gap), #124 (per-agent thinking) in weitzer-org/sound-profile-builder.
- Prices: https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing and https://cloud.google.com/blog/products/ai-machine-learning/gemini-4-argon-available-on-google-cloud (read 2026-11-05). The Gemini Developer API pricing page (ai.google.dev) was not reachable from the eval environment, so confirm against it.
