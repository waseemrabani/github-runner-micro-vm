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

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*" >&2; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "required command '$1' not found on PATH"
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

# Fetch one Output value from a CloudFormation stack.
stack_output() {
  local stack="$1" key="$2"
  aws cloudformation describe-stacks \
    --stack-name "$stack" \
    --query "Stacks[0].Outputs[?OutputKey=='${key}'].OutputValue" \
    --output text
}
