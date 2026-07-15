---
name: quick-review
description: Low-cost, single-pass code review of the current branch diff. Runs entirely inline with NO sub-agents (~1 model call instead of the bundled /code-review's ~17), so it's the default pre-merge review for this repo. Use for routine diffs; escalate to /code-review medium/high or /security-review only for genuinely high-risk changes.
---

# Quick review

The default pre-merge review for this repo. The bundled `/code-review` skill
fans out to **8 finder agents plus up to 8 verifiers** — roughly 17 model
calls per run at `high`, still several at `medium` — which is this project's
single largest discretionary Claude-quota expense. This skill does the same
core job in **one inline pass, spawning no agents at all**.

That tradeoff is deliberate and real: a single pass finds fewer issues than 8
specialized angles. It's affordable *because* this repo already has two other
safety nets: `.github/workflows/deploy.yml` runs the full Jest/Supertest suite
on every push and gates the Fly.io deploy on it passing, and CodeRabbit
reviews every PR automatically at zero Claude quota. Neither catches design,
security, or simplification issues on its own — this skill is the local first
pass; CI and the bot are the backstop.

**Do not spawn sub-agents while running this skill.** If you find yourself
wanting to, that's the signal to stop and tell the user this diff warrants a
full `/code-review medium`/`high` instead.

## Phase 1 — Gather the diff

Run `git diff @{upstream}...HEAD` (fall back to `git diff main...HEAD`). If
there are uncommitted changes or the range diff is empty, also run
`git diff HEAD` — review often runs before the commit. If a PR number, branch,
or path was passed as an argument, review that instead.

## Phase 2 — Single-pass review

Read every hunk. For each one, Read the enclosing function — bugs in
unchanged lines of a touched function are in scope. Work through these lenses
in one pass, in priority order. Correctness always outranks the rest.

**Correctness (the priority):**
- Inverted/wrong conditions, off-by-one, nil/undefined deref, falsy-zero
  checks, wrong-variable copy-paste, errors swallowed in a catch.
- **Removed behavior:** for every deleted or replaced line, name the invariant
  it enforced and find where the new code re-establishes it. If you can't,
  that's a finding.
- **Call sites:** for each changed function, Grep for its callers and check
  the change doesn't break them (new precondition, changed return shape, new
  error path, ordering dependency).

**Repo-specific traps (this codebase has been bitten by patterns like these):**
- **Finding-rendering must escape everything, not just some fields.**
  `adk/frontend/app.js`'s `renderFindings` escapes `severity`/`description`
  via `escapeHTML` but has historically let `agent`/`file` through raw into
  `innerHTML` — and `file` comes straight from PR diff filenames, which are
  attacker-controlled in a malicious PR. Any change touching finding rendering
  must route every LLM- or diff-derived field through `escapeHTML`, not just
  the ones that "look like" free text.
- **Two independent severity floors.** `orchestrator.ts` hardcodes a `"Low"`
  floor that drops LOW findings before they ever reach the caller, entirely
  separate from `severityGate.ts`'s `FAIL_ON_SEVERITY` (used by the GitHub
  Action). Don't assume changing one affects the other.
- **Subagent routing keys off the prompt filename.** `shouldRun` in
  `orchestrator.ts` matches `agent.name.toLowerCase()` against filenames like
  `cicd`, `dependencies`, `secrets`, `promptsecurity` under
  `adk/prompts/system_prompts/`; an unmatched name falls through to "run
  against every file" rather than erroring. Renaming or adding a prompt file
  needs a matching routing-rule update, or a silent behavior change.
- **`agent.ts`'s two-pass (discovery→remediation) mode trusts the LLM's own
  `file`/`line` fields** unlike `analyzeLegacy`, which force-overwrites `file`
  from the actual diff chunk. A hallucinated path here flows toward
  `github.ts`'s inline-comment posting. Flag any change to discovery/
  remediation prompt building that doesn't re-anchor file identity to the
  diff.
- **Storage access only through `storage.ts`'s exports** — no caller should
  instantiate `S3Client` directly (see CLAUDE.md Conventions). Same for the
  eval harness's `tools/eval/storage.ts` mirror.
- **No Vertex AI / ADC / `GOOGLE_APPLICATION_CREDENTIALS`.** Gemini access is
  `GEMINI_API_KEY`-only; flag anything that reintroduces GCP auto-auth.
- **Deduplicator's `agent` field must survive.** `deduplicator.ts`'s prompt
  says findings must retain their `agent` field ("without this, the UI
  breaks") even though the schema marks it nullable — a change that lets it
  drop silently is a finding.

**Cleanup (only if it's clearly worth the maintainer's time):** duplicated
logic that an existing helper already covers (name the helper), needless
complexity, wasted repeated I/O.

**Conventions:** clear violations of the repo-root `CLAUDE.md`. Only flag when
you can quote the exact rule and the exact offending line.

## Phase 3 — Self-verify inline

There is no separate verifier agent, so verify each candidate yourself before
reporting it. Re-read the relevant lines and keep only findings where you can
name the concrete inputs/state that trigger the wrong output. **Drop anything
you can't substantiate** — with no verify pass to catch you, a confident wrong
finding is worse than a missed one. If a mechanism is real but the trigger is
uncertain, keep it and say so explicitly.

## Output

Report findings most-severe first, each with file, line, a one-sentence
summary, and a concrete failure scenario. Cap at ~8. If nothing survives
verification, say so plainly rather than padding.

Then state, in one line, what this pass did **not** cover — so the user knows
what CI/CodeRabbit still need to catch. For example: "Single-pass only; no
dedicated security/injection angle — `/security-review` (also a single-pass
skill) or CodeRabbit remain the check for that."

## When to escalate instead

Tell the user to run the more expensive review when the diff touches:
- agent orchestration, storage/secrets, or auth
- how externally-influenced content (PR diffs, Gemini/agent output) is
  rendered, parsed, or escaped → `/security-review`
- a large or architecturally risky change → `/code-review medium` or `high`
