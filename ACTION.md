# GSR GitHub Action

Run GSR's Gemini-powered code review against a pull request from inside any
repo's own GitHub Actions workflow. The action runs entirely on the
consumer's runner — it builds and runs the GSR backend logic as a Docker
container, reads the PR diff via the GitHub API, and posts findings back as
inline PR review comments. No PAT or diff content is sent to a hosted GSR
service.

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
