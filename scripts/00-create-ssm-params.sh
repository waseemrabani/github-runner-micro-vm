#!/bin/bash
# Creates the two SSM SecureString parameters CloudFormation cannot create
# itself: the webhook HMAC secret and the GitHub App credentials JSON.
# Safe to re-run - it overwrites the existing values.
#
# Usage:
#   PRIVATE_KEY_PATH=/path/to/app-private-key.pem \
#   GITHUB_APP_CLIENT_ID=Iv1.abc123 \
#   GITHUB_APP_INSTALLATION_ID=12345678 \
#   ./00-create-ssm-params.sh
#
# WEBHOOK_SECRET is generated for you (openssl rand -hex 32) if not set in
# the environment. It's printed at the end - copy it into the GitHub
# webhook's "Secret" field.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
source ./lib.sh

require_cmd aws
require_cmd jq

: "${WEBHOOK_SECRET_PARAM_NAME:=/${PROJECT_NAME}/webhook-secret}"
: "${APP_CREDENTIALS_PARAM_NAME:=/${PROJECT_NAME}/app-credentials}"

if [ -z "${GITHUB_APP_CLIENT_ID:-}" ] || [ -z "${GITHUB_APP_INSTALLATION_ID:-}" ] || [ -z "${PRIVATE_KEY_PATH:-}" ]; then
  die "Set GITHUB_APP_CLIENT_ID, GITHUB_APP_INSTALLATION_ID and PRIVATE_KEY_PATH before running this script. See README.md 'Create a GitHub App' for how to get these three values."
fi
[ -f "$PRIVATE_KEY_PATH" ] || die "PRIVATE_KEY_PATH '$PRIVATE_KEY_PATH' does not exist"

WEBHOOK_SECRET="${WEBHOOK_SECRET:-$(openssl rand -hex 32)}"

log "Writing webhook secret to SSM parameter: ${WEBHOOK_SECRET_PARAM_NAME}"
aws ssm put-parameter \
  --name "$WEBHOOK_SECRET_PARAM_NAME" \
  --type SecureString \
  --value "$WEBHOOK_SECRET" \
  --overwrite >/dev/null

log "Writing GitHub App credentials to SSM parameter: ${APP_CREDENTIALS_PARAM_NAME}"
CREDS_JSON="$(jq -n \
  --arg appClientId "$GITHUB_APP_CLIENT_ID" \
  --arg installationId "$GITHUB_APP_INSTALLATION_ID" \
  --rawfile privateKey "$PRIVATE_KEY_PATH" \
  '{appClientId: $appClientId, installationId: $installationId, privateKey: $privateKey}')"

aws ssm put-parameter \
  --name "$APP_CREDENTIALS_PARAM_NAME" \
  --type SecureString \
  --value "$CREDS_JSON" \
  --overwrite >/dev/null

save_state WEBHOOK_SECRET_PARAM_NAME "$WEBHOOK_SECRET_PARAM_NAME"
save_state APP_CREDENTIALS_PARAM_NAME "$APP_CREDENTIALS_PARAM_NAME"

log "Done."
echo
echo "Webhook secret (put this in the GitHub webhook's 'Secret' field):"
echo "  ${WEBHOOK_SECRET}"
echo
echo "SSM parameters written:"
echo "  ${WEBHOOK_SECRET_PARAM_NAME}"
echo "  ${APP_CREDENTIALS_PARAM_NAME}"
