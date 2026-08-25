#!/bin/bash
# Deploys cloudformation/02-orchestrator.yaml: SQS queues, the MicroVM
# execution role, both Lambda functions, and the API Gateway webhook
# endpoint. Requires 01-deploy-foundation.sh, 00-create-ssm-params.sh,
# 02-package-lambdas.sh and 03-build-microvm-images.sh both to have run
# first (this script checks for and refuses to proceed without their
# outputs).
#
# Override any of these via the environment before running:
#   RUNNER_SCOPE=organization|repository   (default: organization)
#   RUNNER_GROUP_ID=1                      (organization scope only)
#   REQUIRED_RUNNER_LABEL=lambda-microvms
#   DOCKER_RUNNER_LABEL=docker
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
source ./lib.sh
load_state

require_cmd aws

: "${CODE_BUCKET_NAME:?Run ./01-deploy-foundation.sh first}"
: "${ORCHESTRATOR_CODE_KEY:?Run ./02-package-lambdas.sh first}"
: "${WORKER_CODE_KEY:?Run ./02-package-lambdas.sh first}"
: "${MICROVM_IMAGE_ARN_DOCKER:?Run ./03-build-microvm-images.sh both first}"
: "${MICROVM_IMAGE_ARN_NO_DOCKER:?Run ./03-build-microvm-images.sh both first}"
: "${WEBHOOK_SECRET_PARAM_NAME:?Run ./00-create-ssm-params.sh first}"
: "${APP_CREDENTIALS_PARAM_NAME:?Run ./00-create-ssm-params.sh first}"

: "${RUNNER_SCOPE:=organization}"
: "${RUNNER_GROUP_ID:=1}"
: "${REQUIRED_RUNNER_LABEL:=lambda-microvms}"
: "${DOCKER_RUNNER_LABEL:=docker}"

case "$RUNNER_SCOPE" in
  organization|repository) ;;
  *) die "RUNNER_SCOPE must be 'organization' or 'repository', got '${RUNNER_SCOPE}'" ;;
esac

log "Deploying stack '${ORCHESTRATOR_STACK_NAME}' (RunnerScope=${RUNNER_SCOPE}) ..."
aws cloudformation deploy \
  --stack-name "$ORCHESTRATOR_STACK_NAME" \
  --template-file "${PROJECT_ROOT}/cloudformation/02-orchestrator.yaml" \
  --capabilities CAPABILITY_NAMED_IAM \
  --no-fail-on-empty-changeset \
  --parameter-overrides \
    "ProjectName=${PROJECT_NAME}" \
    "CodeBucketName=${CODE_BUCKET_NAME}" \
    "OrchestratorCodeKey=${ORCHESTRATOR_CODE_KEY}" \
    "WorkerCodeKey=${WORKER_CODE_KEY}" \
    "MicrovmImageArnDocker=${MICROVM_IMAGE_ARN_DOCKER}" \
    "MicrovmImageArnNoDocker=${MICROVM_IMAGE_ARN_NO_DOCKER}" \
    "WebhookSecretParamName=${WEBHOOK_SECRET_PARAM_NAME}" \
    "AppCredentialsParamName=${APP_CREDENTIALS_PARAM_NAME}" \
    "RunnerScope=${RUNNER_SCOPE}" \
    "RunnerGroupId=${RUNNER_GROUP_ID}" \
    "RequiredRunnerLabel=${REQUIRED_RUNNER_LABEL}" \
    "DockerRunnerLabel=${DOCKER_RUNNER_LABEL}"

WEBHOOK_URL="$(stack_output "$ORCHESTRATOR_STACK_NAME" WebhookUrl)"
save_state WEBHOOK_URL "$WEBHOOK_URL"

log "Orchestrator stack ready."
echo
echo "GitHub webhook Payload URL:"
echo "  ${WEBHOOK_URL}"
echo
echo "Next: configure the webhook in GitHub (see README.md 'Configure GitHub')."
