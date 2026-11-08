#!/bin/bash
# Shared helpers for scripts/*.sh. Sourced, not executed directly.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
STATE_FILE="${SCRIPT_DIR}/.deploy-state.env"

: "${PROJECT_NAME:=github-runner-orchestrator}"
FOUNDATION_STACK_NAME="${PROJECT_NAME}-foundation"
MICROVM_IMAGES_STACK_NAME="${PROJECT_NAME}-microvm-images"
ORCHESTRATOR_STACK_NAME="${PROJECT_NAME}-orchestrator"
OBSERVABILITY_STACK_NAME="${PROJECT_NAME}-observability"
# CloudWatch namespace shared by the Lambdas' and MicroVMs' custom metrics -
# passed to the images, orchestrator and observability stacks alike.
: "${METRICS_NAMESPACE:=GitHubRunnerMicroVMs}"

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*" >&2; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "required command '$1' not found on PATH"
}

hash_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

# Persist a KEY=VALUE pair into the shared state file, replacing any
# existing line for that key. Later scripts source this file to pick up
# outputs from earlier steps (bucket name, image ARNs, etc).
save_state() {
  local key="$1" value="$2"
  touch "$STATE_FILE"
  if grep -q "^${key}=" "$STATE_FILE" 2>/dev/null; then
    # Portable in-place edit (works on both GNU and BSD/macOS sed).
    sed -i.bak "s|^${key}=.*|${key}=${value}|" "$STATE_FILE" && rm -f "${STATE_FILE}.bak"
  else
    echo "${key}=${value}" >> "$STATE_FILE"
  fi
}

load_state() {
  if [ -f "$STATE_FILE" ]; then
    # shellcheck disable=SC1090
    source "$STATE_FILE"
  fi
}

# Fail fast if a stack this script depends on isn't deployed. Values in
# .deploy-state.env outlive the stacks they came from (e.g. after a teardown),
# and passing a deleted role's ARN on to CloudFormation only surfaces minutes
# later as an opaque "did not stabilize".
require_stack() {
  local stack="$1" script="$2" status
  status="$(aws cloudformation describe-stacks --stack-name "$stack" \
    --query 'Stacks[0].StackStatus' --output text 2>/dev/null || echo MISSING)"
  case "$status" in
    CREATE_COMPLETE|UPDATE_COMPLETE|UPDATE_ROLLBACK_COMPLETE|IMPORT_COMPLETE) ;;
    *) die "Stack '${stack}' is ${status}, so values saved in ${STATE_FILE} may be stale. Run ./${script} first (on a fresh deploy, run every script from 00 in order)." ;;
  esac
}

# Fetch one Output value from a CloudFormation stack.
stack_output() {
  local stack="$1" key="$2"
  aws cloudformation describe-stacks \
    --stack-name "$stack" \
    --query "Stacks[0].Outputs[?OutputKey=='${key}'].OutputValue" \
    --output text
}
