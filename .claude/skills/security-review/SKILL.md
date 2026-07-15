---
name: security-review
description: Optional, single-pass adversarial security review for this repo. Runs inline with NO sub-agents (~1 model call, not a fan-out). Run alongside /quick-review (not instead of it) for diffs touching agent orchestration, storage/secrets, auth, or how externally-influenced content (PR diffs, Gemini/LLM output) gets rendered, parsed, or escaped.
---

# Security review

`/quick-review`'s (and `/code-review`'s) standard lenses check whether a
change does what it intends — not whether an adversary can bend it. That gap
is not hypothetical here: this repo's finding-rendering path
(`adk/frontend/app.js`'s `renderFindings`) escapes `severity`/`description` via
`escapeHTML` but has let `agent`/`file` through raw into `innerHTML` (a
separate raw `title="${file}"` sink also exists in the progress-card render,
same file) — and `file` comes straight from PR diff filenames (`github.ts`),
which are fully attacker-controlled in a malicious/crafted PR.
That's a real stored-XSS vector reachable by opening a PR with a crafted
filename, not a theoretical one — the same shape of bug as the sound-profile-
builder project's hand-rolled HTML sanitizer that shipped with XSS bypasses.

**Cost note:** this skill runs as a **single inline pass and spawns no
sub-agents** — deliberately, because a multi-agent fan-out (the bundled
`/code-review`) is the largest discretionary Claude-quota expense in this
project's workflow. The tradeoff is that one focused pass finds less than
several parallel angles; that's acceptable here *because* CodeRabbit and
gemini-code-assist both review every PR automatically at zero Claude quota
and CI (`deploy.yml`) gates deploy on the test suite passing. This skill is
the local adversarial pass; CI and those two bots are the backstop.

**Do not spawn Agent-tool sub-agents while running it** — if the diff feels
too big or dangerous for one pass, say so and recommend the user budget for a
full multi-agent `/code-review high` instead of fanning out here.

This is **optional and additive** — run it in addition to `/quick-review`,
not as a replacement. Reach for it when the diff touches:

- Agent orchestration (`orchestrator.ts`, `agent.ts`, `deduplicator.ts`) or
  the prompt files under `adk/prompts/`.
- Auth, secrets, or credentials (`GEMINI_API_KEY`, `S3_ACCESS_KEY_ID`,
  `S3_SECRET_ACCESS_KEY`, GitHub tokens/App credentials in `github.ts`,
  `action-entrypoint.ts`).
- `storage.ts` (or `tools/eval/storage.ts`) or anything constructing an
  `S3Client` directly.
- How externally-influenced content gets rendered, parsed, or escaped —
  PR diff content and filenames (`github.ts`), Gemini/agent-authored findings
  (`agent.ts`, `deduplicator.ts`) that reach the frontend
  (`adk/frontend/app.js`, `adk/frontend/*.html`).
- The GitHub Action entrypoint (`action-entrypoint.ts`, `action.yml`,
  `severityGate.ts`) — this is the newest and least-reviewed surface, and it
  runs with repo-scoped GitHub credentials inside third-party CI.
- A new third-party dependency.

## Phase 1 — Gather context

Same diff-gathering as `/quick-review`: `git diff main...HEAD` (or the
appropriate upstream/PR range; also `git diff HEAD` if the review runs before
the commit). Additionally, for any diff touching rendering code, read the
`adk/prompts/` file(s) whose output reaches it — that's this project's main
source of externally-influenced content flowing into HTML/JSON output, and
the prompt text tells you what the model is instructed (and therefore, via
prompt injection from a malicious PR description or diff content, can
potentially be coaxed) to emit.

## Phase 2 — Adversarial pass (single pass, no agents)

Work through each angle below yourself, in one pass. Every finding needs a
concrete `file`, `line`, `summary`, and a `failure_scenario` naming the actual
attacker input/state that triggers it — no speculative "this could be risky"
without a constructible trigger.

### Injection / XSS
For every point where a PR diff field, filename, or agent/Gemini-authored
finding is embedded into HTML, a shell command, an object path, or a URL,
assume it's adversarial and ask what breaks:
- **HTML/XSS**: is the value routed through `escapeHTML` (or an equivalent
  real escaping function) before landing in `innerHTML`/`textContent`, or is
  it interpolated raw? Check every field on a rendered finding
  (`severity`, `description`, `agent`, `file`, `line`) individually — escaping
  some fields and not others is exactly the historical bug pattern here, not
  a hypothetical.
- **Path traversal / object-key injection**: any place a PR-derived filename,
  repo name, or run ID is concatenated into an S3 object key
  (`storage.ts`'s callers) or filesystem path without validation.
- **Prompt injection**: does PR diff content or a PR description get
  interpolated into a Gemini prompt in a way that could make the model emit
  attacker-chosen `file`/`agent`/`description` text designed to look like a
  legitimate finding, or to exfiltrate something via a crafted "finding"?
- **Command/argument injection**: anything that shells out or builds a
  command line from PR-derived input (check `action-entrypoint.ts` and any
  git/gh CLI invocations).
- **SSRF**: any outbound URL built from PR- or repo-controlled input (e.g. a
  custom GitHub API base URL, webhook target).

### Auth & authorization
- Does `github.ts` validate that any token/credential used to post comments
  or fetch diffs is scoped appropriately (repo-scoped, not broader than
  needed), and does it come only from env vars / Action inputs — never
  logged or echoed into a comment/response?
- Does the GitHub Action (`action-entrypoint.ts`, `action.yml`) run any step
  with elevated permissions (`GITHUB_TOKEN` write scope, secrets) against
  untrusted PR content (e.g. `pull_request_target` triggers checking out a
  fork's code) — that's a well-known GitHub Actions privilege-escalation
  pattern; flag it even without a concrete demonstrated exploit.
- Does a new API route or Action input create a second path to something an
  existing check already gates?

### Secrets & credential handling
- Does the diff ever log, echo into an HTTP response, PR comment, or error
  message an API key, GitHub token, or S3 credential value?
- Do new env vars / Action inputs follow the existing pattern — never
  committed, `.env` git-ignored locally, injected via `fly secrets set` in
  prod / GitHub Actions secrets in CI?
- No `GOOGLE_APPLICATION_CREDENTIALS`-style auto-loading — Gemini access is
  `GEMINI_API_KEY`-only (see CLAUDE.md Conventions).

### Supply chain
For any dependency added in this diff:
- Is it the standard/recommended library for the problem (prefer boring,
  widely-adopted choices), or a one-off/less-maintained package?
- Does the lockfile's new transitive tree look proportionate to what was
  asked for? (This repo has previously had lockfile issues with stray
  private/Google artifact registry URLs — see commit `7aad53b` — so also
  check the registry origin of new entries, not just the package names.)

## Phase 3 — Self-verify and report

There is no separate verifier agent, so verify each candidate yourself before
reporting. Re-read the actual code and settle each on:
- **CONFIRMED** — you can cite the line and name the attacker input that
  triggers it.
- **PLAUSIBLE** — mechanism is real, trigger realistic but not fully pinned.
  Keep it; XSS via an unescaped finding field is realistic in this codebase
  (it already exists in `app.js`'s `renderFindings`), so don't dismiss it as
  "speculative."
- **REFUTED** — drop it, but only when you can cite the exact line that
  already guards against it.

Report findings via the `ReportFindings` tool if available (ranked
most-severe first). If it isn't available, report as a plain ranked list with
the same `file` / `line` / `summary` / `failure_scenario` fields.

Finally, because this is one pass rather than a fan-out, state plainly what
you did **not** get to (e.g. "did not audit the full GitHub Action permission
model end-to-end") so the user knows what CI/CodeRabbit/gemini-code-assist still need to cover.
