#!/bin/bash
# Deploys cloudformation/04-observability.yaml: an SNS alarm topic, the
# CloudWatch alarms, and the fleet dashboard. Safe to re-run; needs no
# outputs from the other stacks beyond PROJECT_NAME / METRICS_NAMESPACE, but
# is only useful once ./04-deploy-orchestrator.sh has run.
#
# Override via the environment:
#   ALARM_EMAIL=you@example.com     subscribe an address to the alarm topic
#                                   (confirm the email AWS sends)
#   QUEUE_TIME_ALARM_SECONDS=180    p90 queued->started threshold
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
source ./lib.sh
load_state

require_cmd aws

: "${ALARM_EMAIL:=}"
: "${QUEUE_TIME_ALARM_SECONDS:=180}"

log "Deploying stack '${OBSERVABILITY_STACK_NAME}' ..."
aws cloudformation deploy \
  --stack-name "$OBSERVABILITY_STACK_NAME" \
  --template-file "${PROJECT_ROOT}/cloudformation/04-observability.yaml" \
  --no-fail-on-empty-changeset \
  --parameter-overrides \
    "ProjectName=${PROJECT_NAME}" \
    "MetricsNamespace=${METRICS_NAMESPACE}" \
    "AlarmEmail=${ALARM_EMAIL}" \
    "QueueTimeAlarmSeconds=${QUEUE_TIME_ALARM_SECONDS}"

ALARM_TOPIC_ARN="$(stack_output "$OBSERVABILITY_STACK_NAME" AlarmTopicArn)"
DASHBOARD_URL="$(stack_output "$OBSERVABILITY_STACK_NAME" DashboardUrl)"
save_state ALARM_TOPIC_ARN "$ALARM_TOPIC_ARN"

log "Observability stack ready."
echo "  Dashboard:   ${DASHBOARD_URL}"
echo "  Alarm topic: ${ALARM_TOPIC_ARN}"
[ -z "$ALARM_EMAIL" ] || echo "  Confirm the subscription email sent to ${ALARM_EMAIL}."
