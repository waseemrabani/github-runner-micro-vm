'use strict';

const crypto = require('node:crypto');

// Stable GA REST API version.
const GITHUB_API_VERSION = '2022-11-28';
const DEFAULT_API_BASE = 'https://api.github.com';

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Mint a short-lived RS256 App JWT locally (no network call). `iss` is the App client id.
 * @param {string} clientId
 * @param {string} privateKey PEM (PKCS#1 or PKCS#8)
 * @param {number} [nowMs]
 * @returns {string}
 */
function mintAppJwt(clientId, privateKey, nowMs = Date.now()) {
  const nowSec = Math.floor(nowMs / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = { iat: nowSec - 60, exp: nowSec + 540, iss: clientId }; // <=10min window, 60s clock skew
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = crypto.createSign('RSA-SHA256').update(signingInput).sign(privateKey);
  return `${signingInput}.${base64url(signature)}`;
}

/**
 * @param {string} raw JSON string: {appClientId, installationId, privateKey}
 */
function parseAppCredentials(raw) {
  const creds = JSON.parse(raw);
  if (!creds.appClientId || !creds.installationId || !creds.privateKey) {
    throw new Error('app credentials JSON missing appClientId/installationId/privateKey');
  }
  if (!creds.privateKey.includes('PRIVATE KEY')) {
    throw new Error('app credentials privateKey does not look like a PEM private key');
  }
  return creds;
}

function authedPost(url, bearer, body) {
  return fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${bearer}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': GITHUB_API_VERSION,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function getInstallationToken(jwt, installationId, apiBase = DEFAULT_API_BASE) {
  const res = await authedPost(`${apiBase}/app/installations/${installationId}/access_tokens`, jwt);
  if (res.status !== 201) {
    throw new Error(`installation token request failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return data.token;
}

/**
 * Org-scoped JIT runner config. Requires the GitHub App to be installed at
 * the organization level with the "Self-hosted runners" organization
 * permission (read & write), and a runner group the App's installation can
 * register into.
 */
async function generateOrgJitConfig(installationToken, org, params, apiBase = DEFAULT_API_BASE) {
  const res = await authedPost(`${apiBase}/orgs/${org}/actions/runners/generate-jitconfig`, installationToken, {
    name: params.name,
    runner_group_id: params.runnerGroupId,
    labels: params.labels,
    ...(params.workFolder ? { work_folder: params.workFolder } : {}),
  });
  if (res.status !== 201) {
    throw new Error(`org generate-jitconfig failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

/**
 * Repo-scoped JIT runner config. Requires the GitHub App to have the
 * "Administration" repository permission (read & write) on the target repo.
 * Repositories have no runner groups, so runner_group_id is never sent.
 */
async function generateRepoJitConfig(installationToken, owner, repo, params, apiBase = DEFAULT_API_BASE) {
  const res = await authedPost(
    `${apiBase}/repos/${owner}/${repo}/actions/runners/generate-jitconfig`,
    installationToken,
    {
      name: params.name,
      labels: params.labels,
      ...(params.workFolder ? { work_folder: params.workFolder } : {}),
    }
  );
  if (res.status !== 201) {
    throw new Error(`repo generate-jitconfig failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

function buildRunnerName(runId) {
  return `gh-runner-${runId ?? 'unknown'}-${crypto.randomUUID().slice(0, 8)}`;
}

module.exports = {
  mintAppJwt,
  parseAppCredentials,
  getInstallationToken,
  generateOrgJitConfig,
  generateRepoJitConfig,
  buildRunnerName,
};
