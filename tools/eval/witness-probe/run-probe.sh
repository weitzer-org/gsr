#!/usr/bin/env bash
# Probes the candidate witness sandbox (docker run flags) and prints what it
# actually blocks. Needs: docker, go. Builds a static probe, imports it as a
# scratch-style image (no registry pull), runs it under several flag sets.
# Usage: ./run-probe.sh            (run from this directory)
set -u
cd "$(dirname "$0")"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
GOOS=linux CGO_ENABLED=0 go build -o "$WORK/probe" probe.go || exit 1
(cd "$WORK" && tar -c probe) | docker import - witness-probe:local >/dev/null || exit 1

# Workspace under test: PROBE_WORKSPACE if set (e.g. a real actions/checkout),
# else a fake one with a credential-looking .git/config like actions/checkout
# leaves behind by default (persist-credentials: true). The value is a dummy.
if [ -n "${PROBE_WORKSPACE:-}" ]; then
  WS="$PROBE_WORKSPACE"
else
  WS="$WORK/ws"
  mkdir -p "$WS/.git"
  printf '[http "https://github.com/"]\n\textraheader = AUTHORIZATION: basic DUMMY-NOT-A-REAL-TOKEN\n' > "$WS/.git/config"
  chmod -R a+rX "$WS"
fi
# A writable copy WITHOUT .git: what the witness runner would actually mount.
mkdir -p "$WORK/wscopy"
tar -C "$WS" --exclude=.git -c . | tar -x -C "$WORK/wscopy"
chmod -R a+rwX "$WORK/wscopy"

# This is a STRICTER profile than the witness runner's (dockerArgs in
# ../witness-spike/sandbox.ts), which needs an executable 1g /tmp (`go test`
# compiles its binary there), --pids-limit 512 and a configurable memory limit.
# The probe checks what the shared flags block (network, root fs, capabilities,
# uid, env, host files); it does not measure the runner's resource limits.
HARDEN=(--network none --read-only --tmpfs /tmp:rw,noexec,size=64m --user 65534:65534
  --cap-drop ALL --security-opt no-new-privileges --pids-limit 64 --memory 256m --cpus 1)

run() {
  local label="$1"; shift
  echo "=== $label"
  local start end
  start=$(date +%s.%N)
  docker run --rm "$@" witness-probe:local /probe 2>&1 | sed 's/^/  /'
  end=$(date +%s.%N)
  printf '  wall_seconds=%.2f\n' "$(echo "$end - $start" | bc)"
}

# Secrets in the host environment must not leak into the container.
export GEMINI_API_KEY="${GEMINI_API_KEY:-dummy-host-secret}" GITHUB_TOKEN="${GITHUB_TOKEN:-dummy-host-token}"

run "A. docker defaults (baseline, expect permissive)" -v "$WS:/work:ro"
run "B. hardened flags, workspace mounted read-only" "${HARDEN[@]}" -v "$WS:/work:ro"
run "C. hardened + .git hidden by a tmpfs overlay" "${HARDEN[@]}" -v "$WS:/work:ro" --tmpfs /work/.git:ro,size=1k
run "D. hardened + workspace COPY without .git, writable (what the runner would mount)" "${HARDEN[@]}" -v "$WORK/wscopy:/work:rw"

echo "=== E. memory limit (256m): allocate 2 GiB, expect OOM kill"
docker run --rm "${HARDEN[@]}" witness-probe:local /probe -mem 2>&1 | sed 's/^/  /'
echo "  exit_code=${PIPESTATUS[0]} (137 = OOM-killed)"

echo "=== F. wall-clock kill: container sleeping 20s, killed at 3s"
cid=$(docker run -d "${HARDEN[@]}" witness-probe:local /probe -child)
sleep 3; docker kill "$cid" >/dev/null 2>&1
echo "  state_after_kill=$(docker inspect -f '{{.State.Status}} exit={{.State.ExitCode}}' "$cid")"
docker rm -f "$cid" >/dev/null 2>&1
