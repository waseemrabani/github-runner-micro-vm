#!/bin/bash
# Uploads the code artifact for one or both MicroVM runner image flavors,
# then deploys cloudformation/02-microvm-images.yaml, which builds one
# AWS::Lambda::MicrovmImage per enabled runner profile (architecture x flavor
# x size). `aws cloudformation deploy` blocks until the stack reaches
# CREATE_COMPLETE/UPDATE_COMPLETE, which itself waits for every image build
# to finish (several minutes each) - there is no separate polling step to run.
#
# Usage:
#   ./03-deploy-microvm-images.sh both         # docker + no-docker artifacts
#   ./03-deploy-microvm-images.sh docker       # just the Docker-in-Docker artifact
#   ./03-deploy-microvm-images.sh no-docker    # just the plain artifact
#
# Which profiles get built (keys of the Profiles mapping in
# 02-microvm-images.yaml; both lists must be non-empty):
#   NO_DOCKER_PROFILES=arm64-medium,x64-medium            (default)
#   DOCKER_PROFILES=arm64-docker-medium,x64-docker-medium (default)
# Whatever you pass is remembered in .deploy-state.env for the next run.
#
#   REQUIRED_ARCHS=ARM_64,X86_64   (default) the base image version must
#     support all of these. Set REQUIRED_ARCHS=ARM_64 if you only enable
#     arm64 profiles and your Region has no x86_64-capable base image yet.
#   MICROVM_LOG_RETENTION_DAYS=30  (default)
#   FORCE_REBUILD=1   rebuild every image even if no source file changed, so
#     the Dockerfiles' `apt-get upgrade` picks up the latest Ubuntu security
#     fixes (and the newest base image is applied). Run it on a schedule -
#     e.g. weekly - to keep runners patched.
#
# Each flavor's artifact (Dockerfile + app.js + entrypoint.sh) is shared by
# every profile of that flavor on both architectures: the Dockerfile detects
# the architecture it is being built on. Re-running after changing any of
# those files picks up the change automatically: the artifact's S3 key
# includes a content hash, so a changed file produces a new key, which is what
# actually triggers CloudFormation to update the images (it diffs the
# property value, not the object's bytes at an unchanged key).
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
require_stack "$FOUNDATION_STACK_NAME" 01-deploy-foundation.sh
: "${NO_DOCKER_PROFILES:=arm64-medium,x64-medium}"
: "${DOCKER_PROFILES:=arm64-docker-medium,x64-docker-medium}"
: "${REQUIRED_ARCHS:=ARM_64,X86_64}"
: "${MICROVM_LOG_RETENTION_DAYS:=30}"
: "${FORCE_REBUILD:=0}"

usage() { die "usage: $0 <docker|no-docker|both>"; }
FLAVOR_ARG="${1:-}"
[ -n "$FLAVOR_ARG" ] || usage

[ -n "$NO_DOCKER_PROFILES" ] || die "NO_DOCKER_PROFILES must list at least one profile"
[ -n "$DOCKER_PROFILES" ] || die "DOCKER_PROFILES must list at least one profile"
DUPLICATES="$(printf '%s\n' "${NO_DOCKER_PROFILES//,/$'\n'}" "${DOCKER_PROFILES//,/$'\n'}" | sort | uniq -d)"
[ -z "$DUPLICATES" ] || die "profile(s) listed in both NO_DOCKER_PROFILES and DOCKER_PROFILES: ${DUPLICATES//$'\n'/, }"

zip_and_upload() {
  local dockerfile="$1" flavor="$2"
  local stage_dir zip_path hash s3_key
  stage_dir="$(mktemp -d)"
  zip_path="$(mktemp -u).zip"
  cp "${PROJECT_ROOT}/microvm/${dockerfile}" "${stage_dir}/Dockerfile"
  cp "${PROJECT_ROOT}/microvm/app.js" "$stage_dir/"
  cp "${PROJECT_ROOT}/microvm/entrypoint.sh" "$stage_dir/"
  cp "${PROJECT_ROOT}/microvm/package.json" "$stage_dir/"
  local extra=()
  if [ "$FORCE_REBUILD" = "1" ]; then
    # Not used by the build - it only changes the artifact's content hash, so
    # CloudFormation sees a new CodeArtifact.Uri and rebuilds (re-running
    # apt-get upgrade).
    date -u +%Y-%m-%dT%H:%M:%SZ > "${stage_dir}/.build-stamp"
    extra=(.build-stamp)
  fi
  (cd "$stage_dir" && zip -r -X "$zip_path" Dockerfile app.js entrypoint.sh package.json ${extra[@]+"${extra[@]}"} >/dev/null)
  rm -rf "$stage_dir"
  hash="$(hash_file "$zip_path")"
  s3_key="microvm/${flavor}/code-artifact-${hash:0:12}.zip"
  log "Uploading to s3://${CODE_BUCKET_NAME}/${s3_key} ..."
  aws s3 cp "$zip_path" "s3://${CODE_BUCKET_NAME}/${s3_key}" >/dev/null
  rm -f "$zip_path"
  echo "$s3_key"
}

log "Discovering base image versions of ${MICROVM_BASE_IMAGE_ARN} that support ${REQUIRED_ARCHS} ..."

# GetMicrovmImage is not callable on this ARN - it's an AWS-owned managed
# base image (account id "aws" in the ARN, not yours). Use
# list-managed-microvm-image-versions, the API meant for discovering versions
# of AWS's shared base images. Pick the newest version that is AVAILABLE and
# lists every architecture in REQUIRED_ARCHS under supportedCpuConfigurations.
# Some Regions / CLI versions return neither status nor
# supportedCpuConfigurations (confirmed live in ap-southeast-1, 2026-11): a
# version without status counts as AVAILABLE, and one without an architecture
# list falls back to the base image release notes - x86_64 arrived in version
# 3, so versions >= 3 support ARM_64 + X86_64, older ones ARM_64 only. If that
# inference is ever wrong the image build fails with a ValidationException
# rather than building the wrong thing.
VERSIONS_JSON="$(aws lambda-microvms list-managed-microvm-image-versions \
  --image-identifier "$MICROVM_BASE_IMAGE_ARN" --output json)"
# shellcheck disable=SC2016 # $v is a jq variable, not a shell one
ARCHS_JQ='def archs: ((.imageVersion // "0") | tonumber? // 0) as $v
  | [.supportedCpuConfigurations[]?.architecture]
  | if length > 0 then .
    elif $v >= 3 then ["ARM_64", "X86_64"]
    else ["ARM_64"] end;'
MICROVM_BASE_IMAGE_VERSION="$(jq -r --arg archs "$REQUIRED_ARCHS" "$ARCHS_JQ"'
  ($archs | split(",") | map(select(length > 0))) as $need
  | [ .items[]
      | select((.status // "AVAILABLE") == "AVAILABLE")
      | select(archs as $have | all($need[]; . as $a | $have | index($a)))
    ]
  | sort_by(.createdAt) | last | .imageVersion // empty' <<<"$VERSIONS_JSON")"
if [ -z "$MICROVM_BASE_IMAGE_VERSION" ]; then
  echo "$VERSIONS_JSON" | jq -r "$ARCHS_JQ"'.items[] | "  version \(.imageVersion)  status=\(.status // "?")  archs=\(archs | join(","))"' >&2
  die "No AVAILABLE base image version supports ${REQUIRED_ARCHS} (versions above). If x86_64 isn't offered in this Region yet, drop the x64 profiles and re-run with REQUIRED_ARCHS=ARM_64."
fi
log "Base image version: ${MICROVM_BASE_IMAGE_VERSION}"

NO_DOCKER_KEY=""
DOCKER_KEY=""
case "$FLAVOR_ARG" in
  no-docker)
    NO_DOCKER_KEY="$(zip_and_upload Dockerfile.base github-runner-no-docker)"
    ;;
  docker)
    DOCKER_KEY="$(zip_and_upload Dockerfile.docker github-runner-docker)"
    ;;
  both)
    NO_DOCKER_KEY="$(zip_and_upload Dockerfile.base github-runner-no-docker)"
    DOCKER_KEY="$(zip_and_upload Dockerfile.docker github-runner-docker)"
    ;;
  *) usage ;;
esac

# The stack always declares both flavors, so a partial (single-flavor) run
# still needs a value for the flavor not being touched this time - reuse
# whatever key is already on record in state.
: "${NO_DOCKER_KEY:=${MICROVM_NO_DOCKER_CODE_KEY:-}}"
: "${DOCKER_KEY:=${MICROVM_DOCKER_CODE_KEY:-}}"
[ -n "$NO_DOCKER_KEY" ] || die "No prior no-docker code key on record - run './03-deploy-microvm-images.sh both' at least once first"
[ -n "$DOCKER_KEY" ] || die "No prior docker code key on record - run './03-deploy-microvm-images.sh both' at least once first"

# A stack whose first create failed sits in ROLLBACK_COMPLETE, which
# CloudFormation can neither update nor re-create over - say so plainly
# instead of letting `deploy` fail with a generic validation error.
STACK_STATUS="$(aws cloudformation describe-stacks --stack-name "$MICROVM_IMAGES_STACK_NAME" \
  --query 'Stacks[0].StackStatus' --output text 2>/dev/null || true)"
if [ "$STACK_STATUS" = "ROLLBACK_COMPLETE" ]; then
  die "Stack '${MICROVM_IMAGES_STACK_NAME}' is in ROLLBACK_COMPLETE (its first create failed). Delete it, then re-run:
  aws cloudformation delete-stack --stack-name ${MICROVM_IMAGES_STACK_NAME}
  aws cloudformation wait stack-delete-complete --stack-name ${MICROVM_IMAGES_STACK_NAME}"
fi

# DISABLE_ROLLBACK=1 keeps a failed image (and the log group holding its build
# output) instead of deleting them on rollback - use it to debug a failed
# build, then read the log in /aws/lambda-microvms/<ProjectName> and
# `aws lambda-microvms get-microvm-image --image-identifier <ProjectName>-<profile>`.
DEPLOY_EXTRA=()
[ "${DISABLE_ROLLBACK:-0}" = "1" ] && DEPLOY_EXTRA=(--disable-rollback)

log "Deploying stack '${MICROVM_IMAGES_STACK_NAME}' ..."
log "  plain profiles:  ${NO_DOCKER_PROFILES}"
log "  docker profiles: ${DOCKER_PROFILES}"
aws cloudformation deploy \
  --stack-name "$MICROVM_IMAGES_STACK_NAME" \
  --template-file "${PROJECT_ROOT}/cloudformation/02-microvm-images.yaml" \
  --capabilities CAPABILITY_AUTO_EXPAND \
  --no-fail-on-empty-changeset \
  ${DEPLOY_EXTRA[@]+"${DEPLOY_EXTRA[@]}"} \
  --parameter-overrides \
    "ProjectName=${PROJECT_NAME}" \
    "CodeBucketName=${CODE_BUCKET_NAME}" \
    "MicrovmBuildRoleArn=${MICROVM_BUILD_ROLE_ARN}" \
    "MicrovmBaseImageArn=${MICROVM_BASE_IMAGE_ARN}" \
    "MicrovmBaseImageVersion=${MICROVM_BASE_IMAGE_VERSION}" \
    "NoDockerCodeArtifactKey=${NO_DOCKER_KEY}" \
    "DockerCodeArtifactKey=${DOCKER_KEY}" \
    "NoDockerProfiles=${NO_DOCKER_PROFILES}" \
    "DockerProfiles=${DOCKER_PROFILES}" \
    "MetricsNamespace=${METRICS_NAMESPACE}" \
    "MicrovmLogRetentionDays=${MICROVM_LOG_RETENTION_DAYS}"

save_state MICROVM_NO_DOCKER_CODE_KEY "$NO_DOCKER_KEY"
save_state MICROVM_DOCKER_CODE_KEY "$DOCKER_KEY"
save_state NO_DOCKER_PROFILES "$(stack_output "$MICROVM_IMAGES_STACK_NAME" NoDockerProfiles)"
save_state DOCKER_PROFILES "$(stack_output "$MICROVM_IMAGES_STACK_NAME" DockerProfiles)"
save_state MICROVM_LOG_GROUP_NAME "$(stack_output "$MICROVM_IMAGES_STACK_NAME" MicrovmLogGroupName)"
save_state MICROVM_IMAGE_ARN_PREFIX "$(stack_output "$MICROVM_IMAGES_STACK_NAME" MicrovmImageArnPrefix)"
load_state

log "Done."
echo "  Plain profiles:  ${NO_DOCKER_PROFILES}"
echo "  Docker profiles: ${DOCKER_PROFILES}"
echo "  MicroVM logs:    ${MICROVM_LOG_GROUP_NAME}"
echo
echo "Next: ./04-deploy-orchestrator.sh (re-run it whenever the profile lists change)"
