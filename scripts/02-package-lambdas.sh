#!/bin/bash
# Zips both Lambda functions and uploads them to the code bucket created by
# 01-deploy-foundation.sh. The orchestrator ships with no node_modules (the
# Node.js 22.x managed runtime already bundles @aws-sdk/client-ssm and
# @aws-sdk/client-sqs); the worker ships WITH node_modules because
# @aws-sdk/client-lambda-microvms is not part of the standard runtime.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
source ./lib.sh
load_state

require_cmd aws
require_cmd npm
require_cmd zip

: "${CODE_BUCKET_NAME:?Run ./01-deploy-foundation.sh first (CODE_BUCKET_NAME not set)}"

BUILD_DIR="$(mktemp -d)"
trap 'rm -rf "$BUILD_DIR"' EXIT

log "Packaging orchestrator Lambda ..."
ORCH_SRC="${PROJECT_ROOT}/lambda/orchestrator"
ORCH_ZIP="${BUILD_DIR}/orchestrator.zip"
(cd "$ORCH_SRC" && zip -r -X "$ORCH_ZIP" index.js filter.js package.json >/dev/null)

log "Installing worker Lambda dependencies (node_modules is shipped in the zip) ..."
WORKER_SRC="${PROJECT_ROOT}/lambda/worker"
(cd "$WORKER_SRC" && npm install --omit=dev --no-audit --no-fund)

log "Packaging worker Lambda ..."
WORKER_ZIP="${BUILD_DIR}/worker.zip"
(cd "$WORKER_SRC" && zip -r -X "$WORKER_ZIP" index.js github.js microvms.js package.json node_modules >/dev/null)

log "Uploading to s3://${CODE_BUCKET_NAME}/lambda/ ..."
aws s3 cp "$ORCH_ZIP" "s3://${CODE_BUCKET_NAME}/lambda/orchestrator.zip"
aws s3 cp "$WORKER_ZIP" "s3://${CODE_BUCKET_NAME}/lambda/worker.zip"

save_state ORCHESTRATOR_CODE_KEY "lambda/orchestrator.zip"
save_state WORKER_CODE_KEY "lambda/worker.zip"

log "Done. Next: ./03-deploy-microvm-images.sh both"
