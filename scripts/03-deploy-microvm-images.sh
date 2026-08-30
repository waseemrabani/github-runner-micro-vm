#!/bin/bash
# Uploads the code artifact for one or both MicroVM runner image flavors,
# then deploys cloudformation/02-microvm-images.yaml, which builds both as
# native AWS::Lambda::MicrovmImage resources. `aws cloudformation deploy`
# blocks until the stack reaches CREATE_COMPLETE/UPDATE_COMPLETE, which
# itself waits for the image build(s) to finish (several minutes each) -
# there is no separate polling step to run.
#
# Usage:
#   ./03-deploy-microvm-images.sh both         # docker + no-docker
#   ./03-deploy-microvm-images.sh docker       # just the Docker-in-Docker flavor
#   ./03-deploy-microvm-images.sh no-docker    # just the plain flavor
#
# Re-running after changing microvm/app.js, an entrypoint.sh, or a Dockerfile
# picks up the change automatically: the code artifact's S3 key includes a
# content hash, so a changed file produces a new key, which is what actually
# triggers CloudFormation to update the image (it diffs the property value,
# not the object's bytes at an unchanged key).
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

usage() { die "usage: $0 <docker|no-docker|both>"; }
FLAVOR_ARG="${1:-}"
[ -n "$FLAVOR_ARG" ] || usage

hash_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

zip_and_upload() {
  local dockerfile="$1" image_name="$2"
  local stage_dir zip_path hash s3_key
  stage_dir="$(mktemp -d)"
  zip_path="$(mktemp -u).zip"
  cp "${PROJECT_ROOT}/microvm/${dockerfile}" "${stage_dir}/Dockerfile"
  cp "${PROJECT_ROOT}/microvm/app.js" "$stage_dir/"
  cp "${PROJECT_ROOT}/microvm/entrypoint.sh" "$stage_dir/"
  cp "${PROJECT_ROOT}/microvm/package.json" "$stage_dir/"
  (cd "$stage_dir" && zip -r -X "$zip_path" Dockerfile app.js entrypoint.sh package.json >/dev/null)
  rm -rf "$stage_dir"
  hash="$(hash_file "$zip_path")"
  s3_key="microvm/${image_name}/code-artifact-${hash:0:12}.zip"
  log "Uploading to s3://${CODE_BUCKET_NAME}/${s3_key} ..."
  aws s3 cp "$zip_path" "s3://${CODE_BUCKET_NAME}/${s3_key}" >/dev/null
  rm -f "$zip_path"
  echo "$s3_key"
}

log "Discovering current version of base image ${MICROVM_BASE_IMAGE_ARN} ..."

# GetMicrovmImage is not callable on this ARN - it's an AWS-owned managed
# base image (account id "aws" in the ARN, not yours), not one of your own
# custom images, and denies even an admin principal in your own account.
# list-managed-microvm-image-versions is the API meant for exactly this:
# discovering versions of AWS's shared base images. Its items have no
# status/state field (just imageArn/imageVersion/createdAt/updatedAt) -
# confirmed live - so "latest" just means the most recently created one.
MICROVM_BASE_IMAGE_VERSION="$(aws lambda-microvms list-managed-microvm-image-versions \
  --image-identifier "$MICROVM_BASE_IMAGE_ARN" \
  --query "reverse(sort_by(items, &createdAt))[0].imageVersion" \
  --output text)"
[ -n "$MICROVM_BASE_IMAGE_VERSION" ] && [ "$MICROVM_BASE_IMAGE_VERSION" != "None" ] || \
  die "Could not find a version for ${MICROVM_BASE_IMAGE_ARN} - inspect with: aws lambda-microvms list-managed-microvm-image-versions --image-identifier ${MICROVM_BASE_IMAGE_ARN}"
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

# The stack always declares both image resources, so a partial (single
# -flavor) run still needs a value for the flavor not being touched this
# time - reuse whatever key is already on record in state, or fall back to a
# harmless placeholder on a genuinely first-ever run (CloudFormation will
# then build that flavor too, since its key differs from "none").
load_state
: "${NO_DOCKER_KEY:=${MICROVM_NO_DOCKER_CODE_KEY:-microvm/github-runner-no-docker/code-artifact-initial.zip}}"
: "${DOCKER_KEY:=${MICROVM_DOCKER_CODE_KEY:-microvm/github-runner-docker/code-artifact-initial.zip}}"
if [ "$FLAVOR_ARG" = "no-docker" ] || [ "$FLAVOR_ARG" = "docker" ]; then
  [ -n "${MICROVM_NO_DOCKER_CODE_KEY:-}" ] || [ "$FLAVOR_ARG" = "no-docker" ] || \
    die "No prior no-docker code key on record - run './03-deploy-microvm-images.sh both' at least once first"
  [ -n "${MICROVM_DOCKER_CODE_KEY:-}" ] || [ "$FLAVOR_ARG" = "docker" ] || \
    die "No prior docker code key on record - run './03-deploy-microvm-images.sh both' at least once first"
fi

log "Deploying stack '${MICROVM_IMAGES_STACK_NAME}' ..."
aws cloudformation deploy \
  --stack-name "$MICROVM_IMAGES_STACK_NAME" \
  --template-file "${PROJECT_ROOT}/cloudformation/02-microvm-images.yaml" \
  --no-fail-on-empty-changeset \
  --parameter-overrides \
    "ProjectName=${PROJECT_NAME}" \
    "CodeBucketName=${CODE_BUCKET_NAME}" \
    "MicrovmBuildRoleArn=${MICROVM_BUILD_ROLE_ARN}" \
    "MicrovmBaseImageArn=${MICROVM_BASE_IMAGE_ARN}" \
    "MicrovmBaseImageVersion=${MICROVM_BASE_IMAGE_VERSION}" \
    "NoDockerCodeArtifactKey=${NO_DOCKER_KEY}" \
    "DockerCodeArtifactKey=${DOCKER_KEY}"

MICROVM_IMAGE_ARN_NO_DOCKER="$(stack_output "$MICROVM_IMAGES_STACK_NAME" MicrovmImageArnNoDocker)"
MICROVM_IMAGE_ARN_DOCKER="$(stack_output "$MICROVM_IMAGES_STACK_NAME" MicrovmImageArnDocker)"

save_state MICROVM_IMAGE_ARN_NO_DOCKER "$MICROVM_IMAGE_ARN_NO_DOCKER"
save_state MICROVM_IMAGE_ARN_DOCKER "$MICROVM_IMAGE_ARN_DOCKER"
save_state MICROVM_NO_DOCKER_CODE_KEY "$NO_DOCKER_KEY"
save_state MICROVM_DOCKER_CODE_KEY "$DOCKER_KEY"

log "Done."
echo "  MicrovmImageArnNoDocker: ${MICROVM_IMAGE_ARN_NO_DOCKER}"
echo "  MicrovmImageArnDocker:   ${MICROVM_IMAGE_ARN_DOCKER}"
echo
echo "Next: ./04-deploy-orchestrator.sh"
