# Prove It — Phase 1 plan

Status: **proposal, no Phase 1 code yet.** This is sandbox / code-execution
design, so it gets an Opus design review (CLAUDE.md "Escalating") and a
`/security-review` pass before anything is built. Merge is the maintainer's.

## 1. What Phase 0 established (and what it did not)

- The pipeline works end to end: author (Gemini) → validate → 2× head run +
  1× base run in a Docker sandbox → pure `decideVerdict`
  (`adk/backend/src/witness/verdict.ts`). `tools/eval/witness-spike/` holds the
  spike code; `adk/backend/src/witness/` holds only types + verdict.
- Measured with a real Gemini author (`witness-spike/AUTHOR-RESULTS.md`):
  in-sample, v1 prompt 14/77 wrong "proven" verdicts; v2 rule 1/43. Held-out
  synthetic set: 0 wrong in every arm, so it **does not discriminate**. The
  v2 rule is a measured improvement on two findings, not a measured safety
  property.
- Not established: behaviour on real PR findings (see the held-out-set
  proposal; Phase 1 should not ship user-visible "proven" badges before that
  set exists, §6).

## 2. Goals and non-goals

Goals
1. Run witnesses for a PR's findings inside the existing GSR review run and
   attach a verdict to each finding.
2. Fix the five Phase 0 sandbox limits (§4).
3. Never make a finding disappear because of a verdict.

Non-goals
- Defending against a hostile *author of the witness*. The witness author is
  Gemini reading attacker-influenced PR text; a hostile PR package can forge a
  pass (TestMain + `/proc/1/fd/1` + exit 0). Verdicts are evidence about
  honest-but-wrong code. §5 adds a cheap *detection* for the obvious forge
  vector, not a defence.
- Languages beyond Go and JS in Phase 1 (TypeScript needs a ts-jest
  transform; until then it stays `no_witness` → `hypothesis`, never a false
  proof).
- Concurrency/timing, network, DB claims (`needs_environment`).

## 3. Where the sandbox runs

Design review result (Opus, with execution; see §8): the first draft assumed
the review container has no Docker. That is **false**: per the actions/runner
source (`ContainerActionHandler.cs`, fetched, not run on a real runner), the
runner mounts `/var/run/docker.sock` into every container action, and the
action image has no `USER`, so it runs as root. The container that holds
`GEMINI_API_KEY` and `GITHUB_TOKEN` therefore already has root on the runner
today. That exposure exists regardless of Prove It; Phase 1 must not widen it
and should not claim to fix it.

| Option | Pros | Cons |
|---|---|---|
| **B'. Review container calls `docker run` itself (socket already there)** | Smallest change: reuse the Phase 0 sandbox, no `action.yml` rewrite. No new privilege. | Witness code never shares a container with secrets, but the orchestrating process does hold them; a sandbox bug is a bug next to the keys. Self-hosted/ARC runners may not mount the socket (unverified). |
| A. Host-side step between container steps | Secrets are not in the process that launches the witness container. | Needs `action.yml` converted to `using: composite` with manual `docker build/run` (a composite action cannot cleanly `uses:` a Dockerfile inside itself: unverified). Hand-off files add a tamper surface (§5). |
| C. Hosted runner service | Central cache | Ships consumer source off the runner. Rejected. |
| D. gVisor/nsjail/firecracker | Stronger isolation | Not on stock runners. Defer. |

Recommendation: **B' for Phase 1a**, because A's secret-isolation benefit is
smaller than first claimed and its cost is a full action rewrite. Revisit A if
the action is ever converted to composite for other reasons. Either way, the
container that runs witnesses is the only boundary that matters, and it is
the Phase 0 hardened one.

**Hard gates (both options):** witnessing is forced off on
`pull_request_target` and whenever the head repo differs from the base repo.
Fork PRs under `pull_request` get no secrets and the action already fails at
the key check, so they are out of scope. The witness workspace is built only
from git-tracked files of the exact head and base SHAs (fetched without
persisted credentials), never from `/github/workspace`, which is the merge
commit on `pull_request` and may hold credential files from earlier steps.
`outputTail` is never rendered publicly.

## 4. Phase 0 limits → Phase 1 work items

| # | Limit (from Phase 0) | Phase 1 change | Test that would catch regression |
|---|---|---|---|
| 1 | Workspace copy is synchronous `fs.cpSync` in the module that will run inside the Express/Action process | Port `sandbox.ts` into `adk/backend/src/witness/` with an async copy (`fs.promises`, bounded concurrency). Keep symlink-drop and `.git` exclusion. | Copy of a tree with a symlink to an outside file leaves outside untouched; event-loop lag during a large copy stays under a bound. |
| 2 | Jest runner is unsandboxed | Run Jest inside the same hardened container (needs a `witness-node` image: node + jest, no network). Use `--outputFile` to a path inside `/work` rather than parsing stdout, so test `console.log` cannot interleave with the JSON. Keep the exit-code/JSON agreement rule. | Parser fixtures for forged stdout JSON; testbed JS cases run in container. |
| 3 | Go build cache shared | One cache dir per PR run **and separate caches for head and base runs** (head code can poison entries the base run reads, skewing attribution) (created under a 0700 parent, removed after). Cold build ≈47s vs warm ≈1s (Phase 0 measurement), so the 3 runs per finding and all findings of a PR share it; never across PRs or repos. Optional later: restore a read-only cache built from the base commit by a trusted step. | Two runs in the same PR hit the cache; a second PR gets an empty one. |
| 4 | Workspace removal leaves files the host user cannot delete | Run as the host uid (verified: works with `--read-only` only if the cache dir is owned by that uid; `/tmp` tmpfs for GOTMPDIR works). Not sufficient alone: removal of a `000` directory still fails as owner, so chmod recursively before `rm`. `removeWorkspace` must still never throw. | Witness that creates a `0000` directory leaves no residue. |
| 5 | `go test -json` parsed from container stdout | **Dropped.** Verified: host-side `test2json` over `go test -c` output *weakens* forge resistance (a test printing `\x16--- PASS` then `os.Exit(0)` reads as pass; `go test -json` reports inconclusive). Keep `go test -json`. Optionally add `-test.paniconexit0`. `syscall.Exit(0)` forges a pass in both modes, today included. | Forged-pass fixtures for `os.Exit(0)` and the `\x16` marker stay inconclusive. |

## 5. Verdict surfacing — never drop a finding

- A verdict is an annotation on the finding, not a filter. `refuted` collapses
  the comment (summary line + "details" body); it is **never deleted**, and
  `fail-on-severity` keeps counting refuted findings in Phase 1
  (conservative); revisit after the real-PR set (§6).
- `proven_*` adds a badge and the witness source in a collapsed block
  ("Reproduce: …"). Witness source is model output derived from untrusted PR
  content, rendered through the existing escaping path — treat as untrusted
  Markdown/HTML.
- Forge-suspicion signal: if the PR diff touches `TestMain`, an `init()`, or
  any `*_test.go` in the witness's package, or those files contain `/proc/`,
  `os.Exit`, `syscall`, `x/sys` or `//go:linkname`, show a "suspicious
  package" note. It only ever *adds* doubt: it misses imports and other
  files, so a clean result must never read as "not suspicious".
- Because `pass` (refuted) is as forgeable as the rest (`syscall.Exit(0)`
  verified), Phase 1 `on` mode does **not** auto-collapse on `refuted`; it
  shows the verdict as a label until the real-PR set says otherwise.
- Cost/latency caps: at most N findings witnessed per PR (default 10, highest
  severity first), one author call each, per-run timeout 60s, overall step
  budget. Over-cap findings are simply unverdicted.
- Usage: `witness_author` already classifies as eval workload; add a distinct
  `witness` bucket only if the dashboard needs it once real numbers exist.
- Feature flag: `witness: off | observe | on`, mirroring `feedback-loop`.
  **`observe` first**: run and record verdicts to the job summary and the
  feedback store without changing any posted comment. That also produces the
  real-PR data §6 needs.

## 6. Sequencing

1. Held-out real-PR set (decision pending with the maintainer).
2. Phase 1a: port sandbox, async copy, per-PR cache, reliable removal,
   host-side action step, `observe` mode, Go only.
3. Phase 1b: containerized Jest + `--outputFile`; test2json on the host.
4. Compare `observe` verdicts against the real-PR set; only then enable `on`.
5. Promote the v2 rule into `author.md` (keeping a frozen `author.v1.md`)
   as part of 1a.

## 7. Remaining open questions (unverified)

1. Is the runner user uid 1001 on `ubuntu-latest`, and which Go is installed
   on the host?
2. Do self-hosted / ARC runners mount the Docker socket?
3. Is Go's build cache safe for concurrent writers?
4. Missing mechanics to specify: `go mod download` (with network) to fill the
   module cache before the sandbox, image pull, total step-time budget
   (10 findings x 3 runs x 60s plus 47s cold builds).
5. If option A is ever chosen: hand-off files in a fresh `mktemp -d` under
   `RUNNER_TEMP` (never the workspace, which can hold a PR-committed forged
   result), pre-deleted, root-owned from the container, host step under
   `env -i`.

## 8. Design review

Opus review with execution (witness-go:1.24, go1.24.7): verified the
`test2json` regression and `syscall.Exit(0)` forge above, and the host-uid
cache behaviour. Refuted two draft claims (no Docker in the container; host
test2json makes the stream trusted). Runner-source facts come from reading
actions/runner source, not from a live runner.
