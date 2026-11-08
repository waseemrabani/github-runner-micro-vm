#!/bin/bash
# Deploys cloudformation/01-foundation.yaml (S3 code bucket + MicroVM build
# role). Always safe to re-run. Saves its outputs into .deploy-state.env for
# the later scripts to pick up.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
source ./lib.sh

require_cmd aws

log "Deploying stack '${FOUNDATION_STACK_NAME}' ..."
aws cloudformation deploy \
  --stack-name "$FOUNDATION_STACK_NAME" \
  --template-file "${PROJECT_ROOT}/cloudformation/01-foundation.yaml" \
  --parameter-overrides "ProjectName=${PROJECT_NAME}" \
  --capabilities CAPABILITY_NAMED_IAM \
  --no-fail-on-empty-changeset

CODE_BUCKET_NAME="$(stack_output "$FOUNDATION_STACK_NAME" CodeBucketName)"
MICROVM_BUILD_ROLE_ARN="$(stack_output "$FOUNDATION_STACK_NAME" MicrovmBuildRoleArn)"
MICROVM_BASE_IMAGE_ARN="$(stack_output "$FOUNDATION_STACK_NAME" MicrovmBaseImageArn)"
REGION="$(stack_output "$FOUNDATION_STACK_NAME" Region)"

save_state CODE_BUCKET_NAME "$CODE_BUCKET_NAME"
save_state MICROVM_BUILD_ROLE_ARN "$MICROVM_BUILD_ROLE_ARN"
save_state MICROVM_BASE_IMAGE_ARN "$MICROVM_BASE_IMAGE_ARN"
save_state REGION "$REGION"

log "Foundation stack ready."
echo "  CodeBucketName:      ${CODE_BUCKET_NAME}"
echo "  MicrovmBuildRoleArn: ${MICROVM_BUILD_ROLE_ARN}"
echo "  MicrovmBaseImageArn: ${MICROVM_BASE_IMAGE_ARN}"
echo "  Region:              ${REGION}"
echo
echo "Next: ./00-create-ssm-params.sh (if not done already), then ./02-package-lambdas.sh, then ./03-deploy-microvm-images.sh"
