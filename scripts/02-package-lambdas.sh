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
require_stack "$FOUNDATION_STACK_NAME" 01-deploy-foundation.sh

BUILD_DIR="$(mktemp -d)"
trap 'rm -rf "$BUILD_DIR"' EXIT

log "Packaging orchestrator Lambda ..."
ORCH_SRC="${PROJECT_ROOT}/lambda/orchestrator"
ORCH_ZIP="${BUILD_DIR}/orchestrator.zip"
(cd "$ORCH_SRC" && zip -r -X "$ORCH_ZIP" index.js filter.js metrics.js package.json >/dev/null)

log "Installing worker Lambda dependencies (node_modules is shipped in the zip) ..."
WORKER_SRC="${PROJECT_ROOT}/lambda/worker"
(cd "$WORKER_SRC" && npm install --omit=dev --no-audit --no-fund)

log "Packaging worker Lambda ..."
WORKER_ZIP="${BUILD_DIR}/worker.zip"
(cd "$WORKER_SRC" && zip -r -X "$WORKER_ZIP" index.js github.js microvms.js metrics.js package.json node_modules >/dev/null)

# Content-hashed keys: CloudFormation only updates a function's code when
# Code.S3Key changes, so re-uploading over a fixed key would leave the
# deployed functions on the old code after ./04-deploy-orchestrator.sh.
ORCH_KEY="lambda/orchestrator-$(hash_file "$ORCH_ZIP" | cut -c1-12).zip"
WORKER_KEY="lambda/worker-$(hash_file "$WORKER_ZIP" | cut -c1-12).zip"

log "Uploading to s3://${CODE_BUCKET_NAME}/lambda/ ..."
aws s3 cp "$ORCH_ZIP" "s3://${CODE_BUCKET_NAME}/${ORCH_KEY}"
aws s3 cp "$WORKER_ZIP" "s3://${CODE_BUCKET_NAME}/${WORKER_KEY}"

save_state ORCHESTRATOR_CODE_KEY "$ORCH_KEY"
save_state WORKER_CODE_KEY "$WORKER_KEY"

log "Done. Next: ./03-deploy-microvm-images.sh both"
