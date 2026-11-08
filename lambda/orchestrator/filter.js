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

// Label used before profiles became self-contained labels. Still recognised
// so jobs that haven't migrated are rejected with a pointer to the new label
// instead of being silently ignored.
const LEGACY_LABEL = 'lambda-microvms';

/**
 * The label a job uses to request a profile, and the only labels its runner
 * is registered with (lambda/worker/index.js): `self-hosted` + this.
 */
function profileLabel(prefix, profile) {
  return `${prefix}-${profile}`.toLowerCase();
}

/**
 * Decide whether a job is for this deployment and, if so, which runner
 * profile (= MicroVM image) it gets.
 *
 * GitHub hands a queued job to ANY idle runner whose labels include all of the
 * job's labels. Every runner here is registered with exactly
 * [self-hosted, <prefix>-<profile>], so:
 *   - a job must carry exactly one deployed profile label and nothing else
 *     but `self-hosted` - then it matches runners of that profile only, and
 *     all of that profile's runners are identical;
 *   - no runner carries a shared label like `lambda-microvms`, so a job
 *     without a profile label can never take a runner meant for another job.
 * Labels compare case-insensitively, like GitHub.
 *
 * @param {string[]} labels the job's runs-on labels
 * @param {string} prefix RUNNER_LABEL_PREFIX, e.g. 'mvm'
 * @param {string[]} profiles profiles this deployment has images for
 * @returns {{ours: false} |
 *           {ours: true, ok: true, profile: string, label: string, reason: string} |
 *           {ours: true, ok: false, reason: string}}
 */
function resolveProfile(labels, prefix, profiles) {
  const p = prefix.toLowerCase();
  const lower = labels.map((l) => l.toLowerCase());
  const valid = profiles.map((profile) => profileLabel(p, profile));
  const usage = `use exactly one of: ${valid.join(', ')}`;

  const prefixed = lower.filter((l) => l === p || l.startsWith(`${p}-`));
  if (prefixed.length === 0) {
    if (lower.includes(LEGACY_LABEL)) {
      return { ours: true, ok: false, reason: `'${LEGACY_LABEL}' labels are no longer used - ${usage}` };
    }
    return { ours: false };
  }

  const unknown = prefixed.filter((l) => !valid.includes(l));
  if (unknown.length > 0) {
    return { ours: true, ok: false, reason: `[${unknown.join(', ')}] is not a deployed runner profile - ${usage}` };
  }
  if (prefixed.length > 1) {
    return { ours: true, ok: false, reason: `labels name more than one runner profile (${prefixed.join(', ')}) - ${usage}` };
  }
  const extra = lower.filter((l) => l !== 'self-hosted' && l !== prefixed[0]);
  if (extra.length > 0) {
    return {
      ours: true,
      ok: false,
      reason: `labels [${extra.join(', ')}] are not allowed: runners only carry 'self-hosted' and their profile label, so this job could never match one`,
    };
  }
  const profile = profiles[valid.indexOf(prefixed[0])];
  return { ours: true, ok: true, profile, label: prefixed[0], reason: `job requests profile '${profile}'` };
}

/**
 * Milliseconds between two ISO-8601 timestamps from a webhook payload, or
 * undefined if either is missing/unparseable or the interval is negative.
 */
function elapsedMs(fromIso, toIso) {
  const from = Date.parse(fromIso ?? '');
  const to = Date.parse(toIso ?? '');
  if (Number.isNaN(from) || Number.isNaN(to) || to < from) return undefined;
  return to - from;
}

module.exports = { LEGACY_LABEL, parseWorkflowJobEvent, profileLabel, resolveTarget, resolveProfile, elapsedMs };
