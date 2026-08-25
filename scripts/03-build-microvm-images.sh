#!/bin/bash
# Builds one or both MicroVM runner images via the AWS CLI directly.
# CloudFormation has no native resource type for AWS::Lambda::MicrovmImage
# (the multi-minute build exceeds CloudFormation's custom-resource handler
# timeout budget) - this is a script in the CDK reference implementation
# too, just done here with the AWS CLI instead of the JS SDK.
#
# Usage:
#   ./03-build-microvm-images.sh both         # build docker + no-docker
#   ./03-build-microvm-images.sh docker       # just the Docker-in-Docker flavor
#   ./03-build-microvm-images.sh no-docker    # just the plain flavor
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
source ./lib.sh
load_state

require_cmd aws
require_cmd zip
require_cmd jq

: "${CODE_BUCKET_NAME:?Run ./01-deploy-foundation.sh first}"
: "${MICROVM_BUILD_ROLE_ARN:?Run ./01-deploy-foundation.sh first}"
: "${MICROVM_BASE_IMAGE_ARN:?Run ./01-deploy-foundation.sh first}"

POLL_INTERVAL_SECONDS=15
POLL_TIMEOUT_SECONDS=$((12 * 60))

usage() { die "usage: $0 <docker|no-docker|both>"; }
FLAVOR_ARG="${1:-}"
[ -n "$FLAVOR_ARG" ] || usage

# hooks: build-time /ready gets up to 180s (covers dockerd start + any future
# prewarm work); runtime /run and /terminate get 30s each. No /validate hook -
# each MicroVM runs exactly one job and is torn down, so the extra
# platform-side snapshot sampling /validate provides isn't worth the added
# build time here.
HOOKS_JSON='{
  "port": 9000,
  "microvmImageHooks": { "ready": "ENABLED", "readyTimeoutInSeconds": 180 },
  "microvmHooks": {
    "run": "ENABLED", "runTimeoutInSeconds": 30,
    "terminate": "ENABLED", "terminateTimeoutInSeconds": 30
  }
}'
RESOURCES_JSON='[{"minimumMemoryInMiB": 4096}]'

zip_and_upload() {
  local dockerfile="$1" s3_key="$2"
  local stage_dir zip_path
  stage_dir="$(mktemp -d)"
  zip_path="$(mktemp -u).zip"
  cp "${PROJECT_ROOT}/microvm/${dockerfile}" "${stage_dir}/Dockerfile"
  cp "${PROJECT_ROOT}/microvm/app.js" "$stage_dir/"
  cp "${PROJECT_ROOT}/microvm/entrypoint.sh" "$stage_dir/"
  cp "${PROJECT_ROOT}/microvm/package.json" "$stage_dir/"
  (cd "$stage_dir" && zip -r -X "$zip_path" Dockerfile app.js entrypoint.sh package.json >/dev/null)
  rm -rf "$stage_dir"
  log "Uploading to s3://${CODE_BUCKET_NAME}/${s3_key} ..."
  aws s3 cp "$zip_path" "s3://${CODE_BUCKET_NAME}/${s3_key}" >/dev/null
  rm -f "$zip_path"
}

find_existing_image_arn() {
  local image_name="$1"
  aws lambda-microvms list-microvm-images --name-filter "$image_name" \
    --query "items[?name=='${image_name}'].imageArn | [0]" --output text 2>/dev/null | sed 's/^None$//'
}

poll_until_ready() {
  local image_arn="$1"
  local waited=0
  log "Polling image state for ${image_arn} ..."
  while [ "$waited" -lt "$POLL_TIMEOUT_SECONDS" ]; do
    local state
    state="$(aws lambda-microvms get-microvm-image --image-identifier "$image_arn" --query state --output text)"
    echo "  state: ${state}"
    case "$state" in
      CREATED|UPDATED) return 0 ;;
      CREATE_FAILED|UPDATE_FAILED) die "MicroVM image build failed - state: ${state}. Check CloudWatch under /aws/lambda-microvms/*." ;;
    esac
    sleep "$POLL_INTERVAL_SECONDS"
    waited=$((waited + POLL_INTERVAL_SECONDS))
  done
  die "Timed out after ${POLL_TIMEOUT_SECONDS}s waiting for ${image_arn} to reach CREATED/UPDATED"
}

cleanup_old_versions() {
  local image_arn="$1" keep_version="$2"
  [ -n "$keep_version" ] || { warn "No latestActiveImageVersion reported - skipping old-version cleanup"; return; }
  local versions
  versions="$(aws lambda-microvms list-microvm-image-versions --image-identifier "$image_arn" \
    --query 'items[].imageVersion' --output text)"
  for v in $versions; do
    if [ "$v" != "$keep_version" ]; then
      log "Deleting superseded image version ${v}"
      aws lambda-microvms delete-microvm-image-version --image-identifier "$image_arn" --image-version "$v" || \
        warn "Could not delete version ${v} (it may be in use by a running MicroVM) - leaving it in place"
    fi
  done
}

build_flavor() {
  local flavor="$1" # 'docker' | 'no-docker'
  local dockerfile image_name env_key extra_caps
  if [ "$flavor" = "docker" ]; then
    dockerfile="Dockerfile.docker"
    image_name="github-runner-docker"
    env_key="MICROVM_IMAGE_ARN_DOCKER"
    extra_caps='["ALL"]' # required for the Docker-in-Docker daemon: mounting filesystems + network namespaces
  else
    dockerfile="Dockerfile.base"
    image_name="github-runner-no-docker"
    env_key="MICROVM_IMAGE_ARN_NO_DOCKER"
    extra_caps=""
  fi

  log "=== Building MicroVM image: ${image_name} ==="
  local s3_key="microvm/${image_name}/code-artifact.zip"
  zip_and_upload "$dockerfile" "$s3_key"
  local code_artifact_uri="s3://${CODE_BUCKET_NAME}/${s3_key}"

  local existing_arn
  existing_arn="$(find_existing_image_arn "$image_name")"

  local image_arn
  if [ -n "$existing_arn" ]; then
    log "Found existing image ${existing_arn} - updating"
    image_arn="$(aws lambda-microvms update-microvm-image \
      --image-identifier "$existing_arn" \
      --base-image-arn "$MICROVM_BASE_IMAGE_ARN" \
      --build-role-arn "$MICROVM_BUILD_ROLE_ARN" \
      --code-artifact "{\"uri\":\"${code_artifact_uri}\"}" \
      --resources "$RESOURCES_JSON" \
      --hooks "$HOOKS_JSON" \
      ${extra_caps:+--additional-os-capabilities "$extra_caps"} \
      --query imageArn --output text)"
  else
    log "No existing image found - creating"
    image_arn="$(aws lambda-microvms create-microvm-image \
      --name "$image_name" \
      --base-image-arn "$MICROVM_BASE_IMAGE_ARN" \
      --build-role-arn "$MICROVM_BUILD_ROLE_ARN" \
      --code-artifact "{\"uri\":\"${code_artifact_uri}\"}" \
      --resources "$RESOURCES_JSON" \
      --hooks "$HOOKS_JSON" \
      ${extra_caps:+--additional-os-capabilities "$extra_caps"} \
      --query imageArn --output text)"
  fi

  poll_until_ready "$image_arn"

  local latest_version
  latest_version="$(aws lambda-microvms get-microvm-image --image-identifier "$image_arn" \
    --query latestActiveImageVersion --output text)"
  cleanup_old_versions "$image_arn" "$latest_version"

  save_state "$env_key" "$image_arn"
  log "${image_name} ready: ${image_arn} (version ${latest_version})"
}

case "$FLAVOR_ARG" in
  docker) build_flavor docker ;;
  no-docker) build_flavor no-docker ;;
  both) build_flavor docker; build_flavor no-docker ;;
  *) usage ;;
esac

log "Done. Next: ./04-deploy-orchestrator.sh"
