#!/usr/bin/env bash
# Builds the witness-go:1.24 sandbox image from the Go toolchain installed on
# this machine, with no registry pull (Docker Hub is blocked in some
# environments). Where Docker Hub works you can skip this and run with
# WITNESS_IMAGE=golang:1.24 instead; the official image has Go at the same
# /usr/local/go/bin path the runner uses.
set -euo pipefail
GOROOT_DIR="$(GOTOOLCHAIN=local go env GOROOT)"
echo "importing $GOROOT_DIR as witness-go:1.24"
tar -C "$(readlink -f "$GOROOT_DIR")" -c --transform 's,^\./,usr/local/go/,' . | docker import - witness-go:1.24
docker images witness-go:1.24 --format '{{.Repository}}:{{.Tag}} {{.Size}}'
