# GSR GitHub Action

Run GSR's Gemini-powered code review against a pull request from inside any
repo's own GitHub Actions workflow. The action runs entirely on the
consumer's runner — it builds and runs the GSR backend logic as a Docker
container, reads the PR diff via the GitHub API, and posts findings back as
inline PR review comments. No PAT or diff content is ever sent to a hosted
GSR service. By default, nothing about a run leaves your own runner at all —
a usage summary (call counts, tokens, cost, latency) is written to your
workflow run's own Job Summary. Optionally, and only for repos the GSR
maintainer has explicitly approved, that same summary can also be reported
to a hosted GSR endpoint for cost tracking — see "Usage reporting" below.

## Usage

Add a workflow to the consuming repo, e.g. `.github/workflows/gsr-review.yml`:

```yaml
name: GSR Code Review

on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: weitzer-org/gsr@main
        with:
          gemini-api-key: ${{ secrets.GEMINI_API_KEY }}
          mode: subagent   # or "basic"
```

Add `GEMINI_API_KEY` as a repo (or org) secret first: **Settings → Secrets
and variables → Actions**. `permissions: pull-requests: write` is required
so the action's `GITHUB_TOKEN` can post review comments.

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `gemini-api-key` | yes | — | Gemini API key used to run the review. |
| `github-token` | no | `${{ github.token }}` | Token used to read the diff and post comments. |
| `mode` | no | `subagent` | `subagent` runs the full swarm of specialized agents (Architecture, Logic, Security, TechDebt, Testing, ...) plus deduplication — slower/pricier, finds more. `basic` runs a single general-purpose pass — fast/cheap. |
| `fail-on-severity` | no | `none` | Fail the workflow if a finding at or above this severity is found: `critical`, `high`, `medium`, `low`, or `none`. |
| `gemini-model` | no | (GSR's default) | Override the Gemini model used. |
| `max-review-files` | no | `300` | Truncate review to this many changed files. |
| `usage-report-url` | no | (unset) | OPTIONAL. URL of a hosted GSR usage-ingest endpoint to also report this run's usage to. Only set if the GSR maintainer has given you this value — see "Usage reporting" below. |
| `usage-report-key` | no | (unset) | OPTIONAL. Shared secret paired with `usage-report-url`, provided by the GSR maintainer alongside it. Store as a repo secret. |
| `feedback-loop` | no | `off` | OPTIONAL. `off`, `observe`, or `respond` — see "PR comment feedback loop" below. |
| `feedback-max-replies` | no | `3` | OPTIONAL. Only relevant when `feedback-loop` is `respond`. Caps rebuttal decisions reported as "would post" per run — see below. |
| `feedback-min-confidence` | no | `0.7` | OPTIONAL. Only relevant when `feedback-loop` is `respond`. Adjudicator confidence floor (0-1) for a "would post" decision — see below. |

## PR comment feedback loop (opt-in)

Every finding GSR posts carries an invisible marker so a later run can read
back what happened to it. When `feedback-loop` is set to `observe`, each run
first reads reply threads on GSR's own previous findings on the PR,
classifies each reply's stance (accepted / rejected / question / neutral)
with a single batched Gemini call, and writes what it found to this run's
**Job Summary**. **It posts nothing to GitHub** — no new comments, no
replies, no PR writes beyond what the review step already does. No new
permissions or secrets are required; `pull-requests: write` (already needed
to post findings) is sufficient.

This is off by default: even observe-only classification spends your own
Gemini quota, and the feature ships opt-in the same way every cost-adding
input in this action does.

Setting `feedback-loop: respond` additionally runs a second, per-rejection
Gemini call ("adjudication") that judges whether a developer's rejection of
a finding actually holds up against the finding, the reply, and the file's
current diff hunk. **As of this release, `respond` still posts nothing to
GitHub** — it's a dry run: the Job Summary reports each adjudication verdict
and, for rejections the adjudicator says still stand, the full text of the
rebuttal it *would* post, clearly marked as not actually sent. Posting is a
separate, not-yet-enabled stage — this dry-run period exists so real output
can be reviewed before that's turned on. `respond` costs more than `observe`
(one extra Gemini call per adjudicated rejection, capped and reported), and
because nothing is ever posted in this release, that dry-run adjudication
cost repeats on every run for as long as a rejection stands unaddressed —
there's no persisted state to skip re-adjudicating something already looked
at. `feedback-max-replies` and `feedback-min-confidence` only shape that
preview today; they'll cap and gate real posts once posting is enabled.

## Usage reporting (opt-in)

Every run writes a Gemini usage summary (call counts, tokens, cost, latency,
broken down by agent) to this workflow run's own **Job Summary** — nothing
leaves your runner for this.

Centralized reporting to a hosted GSR endpoint is a *separate, opt-in*
feature, off by default, and only usable by repos the GSR maintainer has
explicitly chosen to receive usage data from — the same model already used
for `gemini-api-key` (a value handed to you as a repo secret, never baked
into the public image). If you've been given `usage-report-url` and
`usage-report-key` values, add them as repo secrets and pass them as inputs;
otherwise leave both unset. Only usage metadata (never diff, PR content, or
findings) is ever sent, and a failure to report never fails your workflow.

## Notes

- Only triggers meaningfully on `pull_request` / `pull_request_target`
  events — the action reads `GITHUB_EVENT_PATH` for the PR number.
- If a finding's line can't be mapped onto the diff, the batched review
  submission is retried comment-by-comment; any that still fail are folded
  into the summary comment (with their full content, so nothing is lost)
  instead of failing the whole review.
- This action is unrelated to the Fly.io-hosted `gsr-code-review` app or the
  `tools/eval` harness — it packages `adk/backend`'s orchestrator/agent code
  directly (see `action.yml` / `action.Dockerfile`).
- The repo is public and the action is open to anyone — no access
  restriction is enforced (a source-level allowlist was considered but
  rejected as unenforceable against a fork; see git history if that
  tradeoff needs revisiting later).
