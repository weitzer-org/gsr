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

## 3. The decision that shapes everything: where the sandbox runs

GSR's consumer deployment is a GitHub Action that runs the backend **as a
Docker container on the consumer's runner** (`action.yml`). The Phase 0
sandbox needs `docker run` — from inside that container there is no Docker.

| Option | How | Pros | Cons |
|---|---|---|---|
| **A. Host-side step (recommended)** | The review container writes `witness-jobs.json` (claim + witness source) to a shared dir; a second composite-action step on the runner host runs the sandbox and writes `witness-results.json`; a third step (container again) applies `decideVerdict` and posts. | No Docker socket in any container; sandbox code runs where Docker already exists on `ubuntu-latest`; runner is ephemeral. Verdict logic stays pure and in-container. | Three-step action, two hand-offs; author step must run before the host step, so posting is delayed until after sandboxing; more moving parts in `action.yml`. |
| B. Mount `/var/run/docker.sock` into the review container | Container calls `docker run` itself | Simplest code (reuse Phase 0 as-is) | Socket access = root on the runner, handed to the container that holds `GEMINI_API_KEY` and `GITHUB_TOKEN`. Rejected. |
| C. Hosted runner service (e.g. a Fly app) | POST witness + checkout | Central cache, no consumer Docker dependency | Ships consumer source code to a hosted service — contradicts the Action's "no diff content leaves your runner" promise. Rejected for Phase 1. |
| D. No Docker: gVisor/nsjail/firecracker on host | | Stronger isolation | Not available on stock `ubuntu-latest` without install; large new surface. Defer. |

Recommendation: **A**. The host step must have `GEMINI_API_KEY`/`GITHUB_TOKEN`
**not** in its environment (the Phase 0 container already inherits no host
env; the host step is a plain `node` script with a scrubbed env).

## 4. Phase 0 limits → Phase 1 work items

| # | Limit (from Phase 0) | Phase 1 change | Test that would catch regression |
|---|---|---|---|
| 1 | Workspace copy is synchronous `fs.cpSync` in the module that will run inside the Express/Action process | Port `sandbox.ts` into `adk/backend/src/witness/` with an async copy (`fs.promises`, bounded concurrency). Keep symlink-drop and `.git` exclusion. | Copy of a tree with a symlink to an outside file leaves outside untouched; event-loop lag during a large copy stays under a bound. |
| 2 | Jest runner is unsandboxed | Run Jest inside the same hardened container (needs a `witness-node` image: node + jest, no network). Use `--outputFile` to a path inside `/work` rather than parsing stdout, so test `console.log` cannot interleave with the JSON. Keep the exit-code/JSON agreement rule. | Parser fixtures for forged stdout JSON; testbed JS cases run in container. |
| 3 | Go build cache shared | One cache dir per PR run (created under a 0700 parent, removed after). Cold build ≈47s vs warm ≈1s (Phase 0 measurement), so the 3 runs per finding and all findings of a PR share it; never across PRs or repos. Optional later: restore a read-only cache built from the base commit by a trusted step. | Two runs in the same PR hit the cache; a second PR gets an empty one. |
| 4 | Workspace removal leaves files the host user cannot delete | Run the container as the host uid, with a user-namespace remap if available; fallback: a tiny cleanup container that chowns then deletes. `removeWorkspace` must still never throw. | Witness that creates a `0000` directory leaves no residue. |
| 5 | `go test -json` parsed from container stdout | Build the test binary in the container (`go test -c`), run it, and run `test2json` on the host from captured raw output, so the JSON stream the verdict depends on is produced by trusted code, not by the process the witness controls. (Forged raw output can still lie; the exit-code agreement rule stays.) | Forged `{"Action":"pass"}` lines in test output do not change the outcome. |

## 5. Verdict surfacing — never drop a finding

- A verdict is an annotation on the finding, not a filter. `refuted` collapses
  the comment (summary line + "details" body); it is **never deleted**, and
  `fail-on-severity` keeps counting refuted findings in Phase 1
  (conservative); revisit after the real-PR set (§6).
- `proven_*` adds a badge and the witness source in a collapsed block
  ("Reproduce: …"). Witness source is model output derived from untrusted PR
  content, rendered through the existing escaping path — treat as untrusted
  Markdown/HTML.
- Forge-suspicion downgrade: if the PR diff touches `TestMain`, an `init()`,
  or any `*_test.go` in the witness's package, or the file under test
  contains `/proc/`, `os.Exit`, `syscall` or `//go:linkname`, show the verdict
  as `hypothesis (suspicious package)`. Grep level, detection only.
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

## 7. Open questions for the reviewer (all unverified)

1. Is the host-step hand-off (A) really isolated from the review container's
   secrets on `ubuntu-latest`, given `$GITHUB_ENV`/`$GITHUB_OUTPUT` and a
   shared workspace directory?
2. Does running the container as the host uid break Go's writes to `/gocache`
   or `GOTMPDIR` on a read-only root?
3. Is `go test -c` + host `test2json` behaviour-identical for `-run`,
   timeouts and panics? Phase 0 only used `go test -json`.
4. Is the grep-level forge-suspicion list worth shipping, or does it give
   false confidence?
