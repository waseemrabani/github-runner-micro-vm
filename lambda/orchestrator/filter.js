'use strict';

// Parsing + matching for GitHub `workflow_job` webhook events. Pure functions,
// no AWS SDK calls, so they're trivial to unit test in isolation from
// index.js's SSM/SQS side effects.

/**
 * @param {string} rawBody
 * @returns {object} parsed workflow_job webhook payload
 */
function parseWorkflowJobEvent(rawBody) {
  return JSON.parse(rawBody);
}

/**
 * Match only `queued` workflow_job events whose labels include requiredLabel.
 * @param {object} event parsed webhook payload
 * @param {string} requiredLabel
 * @returns {{matched: boolean, reason: string}}
 */
function matchesRunnerRequest(event, requiredLabel) {
  if (event.action !== 'queued') {
    return { matched: false, reason: `action '${event.action ?? '(none)'}' is not 'queued'` };
  }
  const labels = event.workflow_job?.labels ?? [];
  if (!labels.includes(requiredLabel)) {
    return {
      matched: false,
      reason: `labels [${labels.join(', ')}] do not include required label '${requiredLabel}'`,
    };
  }
  return { matched: true, reason: `queued job requests '${requiredLabel}'` };
}

/**
 * Resolve the GitHub owner (org login, or user login for personal repos)
 * and repo name a JIT runner should be registered against, given the
 * configured RUNNER_SCOPE.
 *
 * - 'organization' requires event.organization.login (present whenever the
 *   repository belongs to a GitHub Organization, regardless of whether the
 *   webhook itself was configured at the org or repo level).
 * - 'repository' only needs event.repository, which is always present on a
 *   workflow_job event.
 *
 * @param {object} event parsed webhook payload
 * @param {'organization'|'repository'} scope
 * @returns {{ok: true, owner: string, repo: string} | {ok: false, reason: string}}
 */
function resolveTarget(event, scope) {
  const repoName = event.repository?.name;
  const repoOwner = event.repository?.owner?.login;

  if (scope === 'organization') {
    const org = event.organization?.login;
    if (!org) {
      return {
        ok: false,
        reason: 'RUNNER_SCOPE=organization but payload has no organization.login (is this repo owned by a GitHub user, not an Org?)',
      };
    }
    if (!repoName) {
      return { ok: false, reason: 'payload is missing repository.name' };
    }
    return { ok: true, owner: org, repo: repoName };
  }

  // scope === 'repository'
  if (!repoOwner || !repoName) {
    return { ok: false, reason: 'payload is missing repository.owner.login or repository.name' };
  }
  return { ok: true, owner: repoOwner, repo: repoName };
}

module.exports = { parseWorkflowJobEvent, matchesRunnerRequest, resolveTarget };
