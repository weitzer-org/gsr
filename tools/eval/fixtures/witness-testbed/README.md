# Witness testbed

Twelve tiny synthetic projects (Go and JavaScript/Jest) used to test the
"Prove It" witness pipeline without a model, a network, or a real repo. Each
case is a seeded finding plus a base and head tree and a reference witness, and
records the verdict the pipeline must reach.

| Case | Expected | What it checks |
|---|---|---|
| go-regression | proven_regression | passes on base, fails on head |
| go-new-code | proven_regression | file absent on base, so no base run |
| go-preexisting | proven_preexisting | fails on base and head |
| go-refuted-false-finding | refuted | the finding is false; witness passes |
| go-fake-too-loose | refuted | false finding; the good witness uses the ctx-aware `MemReader`. `witness.loose.json` invents a ctx-ignoring fake and is wrongly "proven" (a known false proof, see below) |
| go-build-failure | hypothesis | witness does not compile |
| go-timeout | hypothesis | witness hangs; runner kills it |
| go-setup-skip | hypothesis | `t.Skip("gsr-setup: ...")` |
| go-opinion | opinion | `testable:false`, nothing runs |
| js-regression | proven_regression | Jest, base vs head |
| js-refuted-false-finding | refuted | Jest, false finding |
| js-setup-failure | hypothesis | load-time `gsr-setup` throw |

## Run it
```bash
cd tools/eval
npm test                                        # offline structure checks, no Docker
./witness-spike/build-go-image.sh               # once: sandbox image from the local Go toolchain
npx ts-node witness-spike/testbed.ts            # run every case end to end (Go needs Docker)
npx ts-node witness-spike/testbed.ts --only go-regression
npx ts-node witness-spike/testbed.ts --list
```
Go cases run in the hardened container; Jest cases run unsandboxed with
tools/eval's own jest, so this directory must only ever hold trusted fixtures.
A containerized Jest runner is Phase 1.

## The false-proof trap
`go-fake-too-loose` encodes the one wrong "proven" verdict the Phase 0 spike
produced (job_tracker's `Store.Mutate`): the finding is false for real
clients, but a witness whose fake ignores `ctx` fails and gets "proven". The
verdict code cannot catch that; only the author can, by using the package's own
context-aware fake. When tuning the author prompt, count how often an author
produces `witness.json`-style (refuted) versus `witness.loose.json`-style
(false proof) witnesses for this case.

## Threat model and known limits
A witness runs the PR's own code, so its result is only as trustworthy as that
code. Reproduced against the Phase 0 sandbox: a package whose `TestMain` skips
`m.Run`, writes forged `run` and `pass` events to `/proc/1/fd/1` (the
container's stdout, bypassing `test2json`) and exits 0 gets a forged `pass`.
The parser's checks (events must agree with the exit code, build/setup lines
must be package-level, non-event JSON is ignored) stop casual or accidental
forging, not an author who controls the process, because that author controls
every signal the process emits. Consequences for the design:
- `proven_*` and `refuted` are evidence about honest-but-wrong code, not a
  defence against a deliberately hostile PR author.
- A `refuted` verdict must never be the only reason a finding disappears. Keep
  it visible (collapsed) so a forged pass can at worst demote a finding.
- Phase 1 should still move `test2json` and result collection outside the
  container where it can, and treat a pass on a PR that also touches `TestMain`
  or the file under test with extra suspicion.

## Adding a case
Make `cases/<id>/{case.json,head/,base/,witness.json}`. `case.json` needs
`id` (same as the directory), `language`, `finding`, `expectedVerdict`,
`notes`, and optionally `timeoutMs` and `alsoCheck` (extra witness files with
their own expected verdict). Omit the file from `base/` to model code that is
new in the PR. Go witnesses must be named `zz_gsr_witness_test.go` in the
package directory with one `TestGSRWitness`; Jest witnesses
`<name>.gsr-witness.test.js` with one `test('gsr witness', ...)`. The offline
test validates the shape.
