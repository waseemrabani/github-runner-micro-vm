#!/bin/bash
set -euo pipefail

if [ -z "${ENCODED_JIT_CONFIG:-}" ]; then
  echo "Error: ENCODED_JIT_CONFIG is required (generate via POST /orgs|repos/.../actions/runners/generate-jitconfig)" >&2
  exit 1
fi

# The Docker daemon (docker flavor only) is started by app.js before the
# /ready hook fires, so it is already warm and captured in the MicroVM
# snapshot - nothing to start here. run.sh --jitconfig registers the runner,
# runs exactly one job, and exits (the actions runner tears down its own
# registration on exit when started in JIT mode).
exec ./run.sh --jitconfig "$ENCODED_JIT_CONFIG"
