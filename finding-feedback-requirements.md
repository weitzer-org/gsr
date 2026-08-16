# Finding Feedback — Requirements

## 1. Problem

GSR posts findings (via the web UI or the GitHub Action's inline PR comments) and never hears back. There's no way for a consumer to tell us a finding was wrong, unhelpful, or exactly right — and no record of what they did in response. That feedback is the raw material for improving the subagent prompts, but today nothing captures it.

## 2. Primary use case

The main consumer isn't a human clicking a form — it's **another AI coding tool (e.g. Claude Code) that just fixed an issue GSR flagged**, mid-session, and wants to report back:

1. GSR reviews a PR (via Action or UI) and posts findings.
2. A developer's coding agent picks up a finding — either from the PR's inline comments or by querying GSR directly — and fixes (or disputes) it.
3. Before/after fixing, the agent reports: was this finding correct? Here's the code before and after, and here's what I think of GSR's suggestion.
4. That record is stored, tagged with enough provenance (which agent/prompt produced the finding) to eventually be mined for prompt improvement.

A secondary, lower-priority use case: a human browsing review history in the web UI manually flags a finding as good/bad. Same data model, different transport, later phase.

## 3. Non-goals (v1)

- Automatically incorporating feedback into prompts (the "eventual" dataset use is future work — see §9).
- Editing or deleting previously submitted feedback (append-only log is sufficient).
- Feedback on the review as a whole (severity mix, coverage) — v1 is finding-scoped only.
- Changing how the GitHub Action posts PR comments today (batched review + per-comment fallback in `github.ts`'s `postReviewComments` stays as-is).

## 4. Key architectural gaps this feature must close

Explored in `adk/backend/src/types.ts`, `app.ts`, `storage.ts`, `action-entrypoint.ts`, `github.ts`, `adk/frontend/app.js`:

- **No finding ID.** `CandidateFinding` (`types.ts:11-20`) has no `id`. Findings are identified only positionally / by content.
- **No review ID.** Persisted review records (`app.ts:141-148`) key off a sanitized PR URL + timestamp, not a stable review ID.
- **Action-triggered reviews aren't persisted at all.** `action-entrypoint.ts` runs the orchestrator in-process and posts straight to GitHub via `postReviewComments` — it never touches `storage.ts`. So a large fraction of real-world findings (anything reviewed via the Action, which is the primary path for the stated use case) currently has zero backend record to reference.
- **No non-browser auth path.** `requireAuth` (`auth.ts`) is a signed-cookie session gate built for the browser login flow. An agent running headless in CI or a local terminal can't do that handshake.

Decisions below close these gaps deliberately narrowly for v1 rather than solving all of them (e.g., full Action persistence is explicitly deferred — see §5.3).

## 5. Decisions (confirmed)

### 5.1 Interface: API-first, UI secondary
v1 ships a programmatic surface (REST + MCP, see §6). A "give feedback" affordance in the web UI's review-history view (`renderFindings` in `app.js`, currently non-interactive) is a v1.1 follow-on, reusing the same backend endpoint and data model.

### 5.2 Auth: shared secret
One `FEEDBACK_SHARED_SECRET` env var, checked via a request header — mirrors the existing `EVALUATOR_SHARED_SECRET` / `X-Internal-Key` pattern (`tools/eval/internalAuth.ts`) rather than introducing per-consumer API keys or GitHub-token validation. Simplest option consistent with this repo's conventions.

**Departure from the `EVALUATOR_SHARED_SECRET` precedent, called out explicitly:** that secret is optional/warn-only in production because it protects an *outbound* call the backend itself makes. `FEEDBACK_SHARED_SECRET` protects a new *inbound*, publicly-reachable write endpoint on an app whose default URL is directly discoverable (per CLAUDE.md's Auth section). Left unauthenticated, anyone could write arbitrary JSON into the feedback bucket — noise at best, a poisoning vector for the eventual prompt-tuning dataset at worst. **Recommendation: `FEEDBACK_SHARED_SECRET` should be required at production boot** (`assertProductionAuthConfigured`-style fail-fast), same strictness as `UI_PASSWORD`, not the same as `EVALUATOR_SHARED_SECRET`.

The feedback endpoint should accept **either** a valid `FEEDBACK_SHARED_SECRET` header **or** a valid `gsr_auth_session` cookie — so the same endpoint serves both the headless-agent path and the future logged-in-browser path without two implementations.

#### 5.2.1 Auth, concretely, per consumer

The credential is the same everywhere (`X-Feedback-Key: <FEEDBACK_SHARED_SECRET>`, or the session cookie for the browser) — what differs is **how each consumer gets hold of it**, and that's where the real difference in trust/operational cost shows up:

| Consumer | Credential source | Custody story |
|---|---|---|
| **Web UI** (human, browser) | Existing `gsr_auth_session` cookie from password login | Free — reuses 100% of existing auth infra, `authFetch` sends it automatically. No new secret involved. |
| **Claude Code / MCP** (developer's local machine, interactive) | `FEEDBACK_SHARED_SECRET` value pasted into the developer's shell env, referenced by the MCP server config's header (§6.1) | Weakest link. A bare laptop has no existing credential to bootstrap trust from — the secret has to be handed to every developer out-of-band (password manager, onboarding doc). |
| **GitHub Actions context** (a downstream automated-fixer workflow step, in a *consuming* repo, running a coding agent non-interactively) | `FEEDBACK_SHARED_SECRET` stored as that repo's own `Settings → Secrets and variables → Actions` entry, exposed to the step as `${{ secrets.GSR_FEEDBACK_KEY }}` | Cleanest of the three — GitHub Actions secrets are already an established, audited, per-repo mechanism. No new distribution problem. |

Note GSR's own review-posting Action (`action-entrypoint.ts`) is **not** a feedback submitter — it only produces findings. "GitHub Action" as a feedback consumer means a *separate* workflow (in whichever repo GSR is reviewing) that reads GSR's findings and acts on them non-interactively, e.g. an auto-fix step.

**Cross-cutting risk worth flagging now, not after the fact:** the shared-secret decision (§5.2) was made when the only precedent was `EVALUATOR_SHARED_SECRET`, which lives in exactly two first-party Fly apps GSR itself controls. This feature hands the *same kind* of secret to an open-ended set of external consumer repos' GitHub secrets **and** individual developers' shell configs. A single leaked copy — a laptop, a misconfigured repo secret exposed in a log — compromises write access for every consumer until rotated, and rotation means touching every holder's config, not just two Fly apps. This doesn't override the earlier decision (still the right v1 tradeoff for simplicity), but v1 should ship with: (a) a documented rotation runbook, not an afterthought, and (b) treating `submittedBy` (§5.4) as a self-reported attribution trail — not cryptographic proof, but enough to trace misuse to a source even under one shared secret. If leakage becomes a real incident rather than a theoretical one, that's the trigger to revisit per-consumer keys (rejected for v1 complexity, not because the risk wasn't real).

### 5.3 Finding identity: content-hash, no Action changes in v1
No change to `action-entrypoint.ts` or review persistence for v1. Instead:

- `findingId = sha256(file | line | agent | summary)`, truncated (e.g. 16 hex chars).
- Computed wherever a finding is emitted (orchestrator/action-entrypoint output) or, if that's not practical without touching those files, computed identically by the feedback submitter from the same finding fields it already has (it just fixed the issue, so it has the original finding JSON/PR-comment body in hand).
- Because the hash is content-derived, feedback is **self-describing**: the payload carries a snapshot of the finding it's about (file, line, severity, summary, agent), not just an ID pointing at a record that, for Action runs, doesn't exist.

**Known limitation, accepted for v1:** `summary` is LLM-generated and may not be byte-identical across two runs that "find the same thing," so the hash isn't a guaranteed stable key across reruns — it's a best-effort correlation key, not a foreign key. If this proves too lossy once real feedback volume comes in, the fallback is §5.3's deferred alternative: have the Action persist findings with server-assigned IDs (like the UI path already does). Revisit after v1 usage data, not before.

### 5.4 Feedback payload: structured verdict + text + code pair

```ts
interface FindingFeedback {
  // What finding this is about (self-contained snapshot, not a lookup)
  findingId: string;          // content hash, see 5.3
  file: string;
  line: number;
  severity: string;
  agent: string;
  summary: string;

  // Context
  reviewUrl: string;           // PR URL the finding came from
  promptVersion?: string;      // promptsDirName used for this run, e.g. "system_prompts" | "system_prompts_v2" — see 9.1

  // The feedback itself
  verdict: "valid" | "invalid" | "partial";
  comment: string;             // free text, why

  // Optional: what the consumer actually did about it
  exampleCodeBefore?: string;
  exampleCodeAfter?: string;
  codeFeedback?: string;       // commentary specifically on the example — e.g. "the suggested fix didn't account for X"

  // Provenance
  submittedBy: string;         // free-text consumer identifier, e.g. "claude-code", "cursor", "manual-ui"
  submittedAt: string;         // ISO timestamp, server-assigned
}
```

Size limits to bound abuse: `comment` and `codeFeedback` capped (e.g. 4KB each), `exampleCodeBefore`/`After` capped (e.g. 32KB each), overall request body capped (e.g. 200KB) — generous enough for a real diff snippet, small enough that the endpoint can't become a blob-storage side channel.

**Batching:** a coding agent fixing several flagged issues in one PR session will likely have feedback on multiple findings at once. The endpoint should accept either a single `FindingFeedback` object or `{ reviewUrl, items: FindingFeedback[] }` for a batch — avoids N auth round-trips for N findings in one PR.

## 6. Transport: REST + MCP

**REST is the source of truth.** `POST /api/findings/feedback`, declared *before* the global `app.use(requireAuth)` (`app.ts:43`) with its own dedicated auth middleware (§5.2's either/or check), following the same placement pattern as `/api/status`. Companion read endpoint `GET /api/findings/feedback` (auth via existing session, mirrors `/api/review/history`'s list+detail shape) for humans and for the future eval-harness consumer.

**MCP is a thin adapter on top of it**, added because the primary consumer (Claude Code and similar tools) will reach this from inside an agent session, not via hand-written `curl`. Rather than a separate stdio package to install, mount it as a **remote MCP server on the same Express backend** (e.g. `/mcp`), authenticated with the *same* `FEEDBACK_SHARED_SECRET` header — Claude Code's `claude mcp add --transport http` supports custom headers, so setup is one command pointing at the existing Fly app, no new deployable. One auth story, one data model, two transports.

Tool surface for v1:
- `submit_review_feedback` — maps directly to the REST payload in §5.4 (single or batch).

Deferred to v1.1, not required for the core ask: a read-side `list_review_findings` tool so an agent could query GSR structurally instead of parsing PR-comment markdown. Worth doing eventually since `formatFindingBody` (`github.ts:80-87`) output isn't designed to be machine-parsed back, but it's not blocking — the agent already sees findings as inline PR comments it's responding to.

### 6.1 MCP installation in Claude Code

Two install modes, both standard Claude Code MCP mechanics (remote HTTP transport, custom headers, scoped config) — nothing GSR-specific about the mechanism itself:

**Project-scoped** — check a `.mcp.json` into the *consuming* repo (e.g. `logo-maker`, not GSR's own repo):
```json
{
  "mcpServers": {
    "gsr-feedback": {
      "type": "http",
      "url": "https://gsr-code-review.fly.dev/mcp",
      "headers": { "X-Feedback-Key": "${GSR_FEEDBACK_KEY}" }
    }
  }
}
```
Auto-available to any teammate who clones that repo (Claude Code prompts for one-time approval the first time a project-scoped server is used — expected, not a bug), but the config is duplicated across every repo GSR reviews, and each still needs `GSR_FEEDBACK_KEY` present in the developer's environment for the interpolation to resolve.

**User-scoped** — one command, once per developer, works across every repo they touch:
```bash
claude mcp add gsr-feedback \
  --transport http https://gsr-code-review.fly.dev/mcp \
  --header "X-Feedback-Key: ${GSR_FEEDBACK_KEY}" \
  --scope user
```
**Recommended for v1** — avoids duplicating the same server config into every consuming repo, and keeps the secret in the developer's own shell env rather than pasted into N repos' committed config (even templated via `${VAR}`, a committed `.mcp.json` is one more place someone could hardcode the literal value by mistake).

Either way, distributing `GSR_FEEDBACK_KEY` itself to each developer is the actual open problem — see §5.2.1's custody table. *(Confirm exact `${VAR}` interpolation syntax for headers against current Claude Code docs at implementation time — the mechanism is stable, the CLI surface moves fast enough that exact flags are worth a final check.)*

## 7. Storage

Same S3-compatible layer as everything else (`adk/backend/src/storage.ts`'s `uploadJson`/`listFiles`) — a **new bucket**, not a prefix inside `gsr-review-results`, matching the existing one-bucket-per-concern split (results vs eval-results are already separate). A shared bucket with a `feedback/` prefix would need less provisioning, but the separate bucket keeps future lifecycle/retention/IAM policy independent from review data, which matters more once this becomes a dataset people build tooling against.

- Env var `S3_FEEDBACK_BUCKET`; prod default `gsr-review-feedback`, local default `gsr-review-feedback-local` (matching the existing `-local` suffix convention on `gsr-eval-results-local` / `gsr-review-results-local`).
- Key format mirrors the review-run convention: `feedback_<ISO-timestamp>_<safe-review-url>_<findingId>.json`.
- Append-only — no update/delete, consistent with how review and eval results are already handled. Duplicate/retry submissions are accepted as separate log entries rather than deduped; harmless for an eventual dataset (more signal, not corrupted signal), and avoids adding idempotency-key infrastructure for v1.

**Provisioning, concretely — checked against how the existing two buckets actually get created, not assumed:**
- **Local (MinIO)**: `adk/backend/src/storage.ts` has no auto-create logic of its own — the two existing buckets are created by `docker-compose.yml`'s one-shot `createbuckets` service (`mc mb --ignore-existing`, gated via `depends_on: condition: service_completed_successfully`). Adding the feedback bucket means adding `S3_FEEDBACK_BUCKET` to that service's `environment:` block and one more `mc mb --ignore-existing local/$${S3_FEEDBACK_BUCKET};` line, plus the matching entry in `app`'s `environment:` block and `.env.example`. Same pattern, third bucket.
- **Production (R2)**: unlike `tools/eval/storage.ts` (which has `ensureBucketExists`/`CreateBucketCommand`), `adk/backend/src/storage.ts` does **not** auto-create buckets — `gsr-review-results` was provisioned manually in the Cloudflare R2 dashboard. Same manual step needed for `gsr-review-feedback`, then `fly secrets set S3_FEEDBACK_BUCKET=gsr-review-feedback --config fly.toml` (reusing the existing `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY`/`S3_ENDPOINT` creds — R2 credentials aren't bucket-scoped in this setup, only the bucket name changes).

## 8. Security considerations (flag for `/security-review` before implementation)

- `FEEDBACK_SHARED_SECRET` must be required in production (§5.2) — this is a new inbound gate on a publicly-discoverable app, not a supplementary outbound one.
- The endpoint accepts free-text and code blobs from a semi-trusted, non-interactive caller — apply the same escaping discipline on any surface that later *renders* feedback (a future admin/eval view) that CLAUDE.md already flags as inconsistent in `renderFindings` (`agent`/`file` unescaped). Don't repeat that gap in new rendering code.
- Size caps (§5.4) double as basic abuse mitigation for a publicly-reachable write endpoint; consider a coarse rate limit per secret/IP if this becomes a spam vector.
- MCP-over-HTTP is a newer transport; confirm whatever MCP SDK version is used handles the shared-secret header correctly and doesn't log it.

## 9. Future work (explicitly out of scope now, noted so v1 doesn't foreclose it)

### 9.1 Feeding the prompt-improvement loop
The user's stated eventual goal is using this feedback to improve/store prompts. Today, `CandidateFinding` and the persisted review payload (`app.ts:141-148`) carry no record of *which* prompt set produced a finding — `promptsDirName` (`system_prompts` vs `system_prompts_v2`, `orchestrator.ts:17-19`) is an internal orchestrator construction param, never surfaced in output. Recommend threading `promptVersion` through to both the review payload and feedback records now (cheap, additive) even though nothing consumes it yet in v1 — without it, feedback collected today can't be attributed to a prompt version once the dataset work starts.

### 9.2 Eval harness integration
`tools/eval` has no existing feedback-ingestion hook (`llm-comparator.ts` does LLM-vs-LLM judging only, against a hand-curated PR list). Turning the feedback bucket into a dataset the eval harness or a fine-tuning/few-shot pipeline consumes is real, separate design work — not scoped here.

### 9.3 Web UI feedback form (v1.1)
Add a "give feedback" affordance to `renderFindings` (`app.js:342-364`, currently a static, non-interactive render keyed by `.finding` divs with no IDs) — reuses the REST endpoint and payload from §5-7, session-cookie auth path already covered by the either/or design in §5.2.

### 9.4 Action persistence (deferred alternative to 5.3)
If content-hash correlation (§5.3) proves too lossy in practice, revisit having `action-entrypoint.ts` call the backend to persist findings with server-assigned IDs before/while posting PR comments — the same shape the UI path already uses in `app.ts`. Bigger lift (changes the Action's control flow and adds a network dependency to what's currently a self-contained orchestrator run), so only worth it if the hash approach demonstrably breaks correlation in real usage.

## 10. Open questions for implementation time

- Exact hash truncation length and collision tolerance for `findingId` (§5.3) — low stakes, pick something during implementation.
- Whether `submittedBy` should be a free-text field (v1, simplest) or an enum of known integrations — free text is fine until there's a reason to constrain it.
- Where the MCP route lives in `app.ts` relative to the auth gate, and which MCP SDK/version to standardize on — implementation detail, not a requirements-level decision.
