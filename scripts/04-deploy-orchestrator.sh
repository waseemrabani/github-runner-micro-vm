#!/bin/bash
# Deploys cloudformation/03-orchestrator.yaml: SQS queues, the MicroVM
# execution role, both Lambda functions, and the API Gateway webhook
# endpoint. Requires 01-deploy-foundation.sh, 00-create-ssm-params.sh,
# 02-package-lambdas.sh and 03-deploy-microvm-images.sh to have run first
# (this script checks for and refuses to proceed without their outputs).
# Re-run it after 03-deploy-microvm-images.sh whenever the profile lists
# change, so the Lambdas route the new set of profile labels.
#
# Override any of these via the environment before running:
#   RUNNER_SCOPE=organization|repository   (default: organization; use
#                                           repository for repos owned by a
#                                           personal account. Remembered in
#                                           .deploy-state.env once set.)
#   RUNNER_GROUP_ID=1                      (organization scope only)
#   RUNNER_LABEL_PREFIX=mvm                jobs use runs-on: [self-hosted,
#                                           <prefix>-<profile>], e.g.
#                                           mvm-x64-docker-medium
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
source ./lib.sh
load_state

require_cmd aws

: "${CODE_BUCKET_NAME:?Run ./01-deploy-foundation.sh first}"
: "${ORCHESTRATOR_CODE_KEY:?Run ./02-package-lambdas.sh first}"
: "${WORKER_CODE_KEY:?Run ./02-package-lambdas.sh first}"
: "${NO_DOCKER_PROFILES:?Run ./03-deploy-microvm-images.sh both first}"
: "${DOCKER_PROFILES:?Run ./03-deploy-microvm-images.sh both first}"
: "${MICROVM_LOG_GROUP_NAME:?Run ./03-deploy-microvm-images.sh both first}"
: "${MICROVM_IMAGE_ARN_PREFIX:?Run ./03-deploy-microvm-images.sh both first}"
: "${WEBHOOK_SECRET_PARAM_NAME:?Run ./00-create-ssm-params.sh first}"
: "${APP_CREDENTIALS_PARAM_NAME:?Run ./00-create-ssm-params.sh first}"
require_stack "$FOUNDATION_STACK_NAME" 01-deploy-foundation.sh
require_stack "$MICROVM_IMAGES_STACK_NAME" "03-deploy-microvm-images.sh both"
for param in "$WEBHOOK_SECRET_PARAM_NAME" "$APP_CREDENTIALS_PARAM_NAME"; do
  aws ssm get-parameter --name "$param" --query Parameter.Name --output text >/dev/null 2>&1 || \
    die "SSM parameter ${param} not found - run ./00-create-ssm-params.sh first"
done

: "${RUNNER_SCOPE:=organization}"
: "${RUNNER_GROUP_ID:=1}"
: "${RUNNER_LABEL_PREFIX:=mvm}"

case "$RUNNER_SCOPE" in
  organization|repository) ;;
  *) die "RUNNER_SCOPE must be 'organization' or 'repository', got '${RUNNER_SCOPE}'" ;;
esac

# IAM grants RunMicrovm / TerminateMicrovm on exactly these image ARNs.
RUNNER_IMAGE_ARNS="$(printf '%s\n' "${NO_DOCKER_PROFILES//,/$'\n'}" "${DOCKER_PROFILES//,/$'\n'}" \
  | sed "s|^|${MICROVM_IMAGE_ARN_PREFIX}|" | paste -sd, -)"

log "Deploying stack '${ORCHESTRATOR_STACK_NAME}' (RunnerScope=${RUNNER_SCOPE}) ..."
aws cloudformation deploy \
  --stack-name "$ORCHESTRATOR_STACK_NAME" \
  --template-file "${PROJECT_ROOT}/cloudformation/03-orchestrator.yaml" \
  --capabilities CAPABILITY_NAMED_IAM \
  --no-fail-on-empty-changeset \
  --parameter-overrides \
    "ProjectName=${PROJECT_NAME}" \
    "CodeBucketName=${CODE_BUCKET_NAME}" \
    "OrchestratorCodeKey=${ORCHESTRATOR_CODE_KEY}" \
    "WorkerCodeKey=${WORKER_CODE_KEY}" \
    "NoDockerProfiles=${NO_DOCKER_PROFILES}" \
    "DockerProfiles=${DOCKER_PROFILES}" \
    "MicrovmLogGroupName=${MICROVM_LOG_GROUP_NAME}" \
    "RunnerImageArns=${RUNNER_IMAGE_ARNS}" \
    "MetricsNamespace=${METRICS_NAMESPACE}" \
    "WebhookSecretParamName=${WEBHOOK_SECRET_PARAM_NAME}" \
    "AppCredentialsParamName=${APP_CREDENTIALS_PARAM_NAME}" \
    "RunnerScope=${RUNNER_SCOPE}" \
    "RunnerGroupId=${RUNNER_GROUP_ID}" \
    "RunnerLabelPrefix=${RUNNER_LABEL_PREFIX}"

WEBHOOK_URL="$(stack_output "$ORCHESTRATOR_STACK_NAME" WebhookUrl)"
save_state WEBHOOK_URL "$WEBHOOK_URL"
save_state RUNNER_SCOPE "$RUNNER_SCOPE"
save_state RUNNER_GROUP_ID "$RUNNER_GROUP_ID"
save_state RUNNER_LABEL_PREFIX "$RUNNER_LABEL_PREFIX"

log "Orchestrator stack ready."
echo
echo "GitHub webhook Payload URL:"
echo "  ${WEBHOOK_URL}"
echo
echo "Runner labels - each job uses exactly one: runs-on: [self-hosted, <label>]"
printf '%s\n' "${NO_DOCKER_PROFILES//,/$'\n'}" "${DOCKER_PROFILES//,/$'\n'}" | sed "s|^|  ${RUNNER_LABEL_PREFIX}-|"
echo
echo "Next: configure the webhook in GitHub (see README.md 'Configure GitHub'),"
echo "then ./05-deploy-observability.sh for alarms + the dashboard."
