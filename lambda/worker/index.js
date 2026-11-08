'use strict';

const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
const {
  buildRunnerName,
  generateOrgJitConfig,
  generateRepoJitConfig,
  getInstallationToken,
  mintAppJwt,
  parseAppCredentials,
} = require('./github');
const { buildMicrovmConfig, imageArnForProfile, runMicrovmWithRetry } = require('./microvms');
const { putMetric } = require('./metrics');

const APP_CREDENTIALS_PARAM = process.env.GITHUB_APP_CREDENTIALS_PARAM;
const RUNNER_GROUP_ID = Number(process.env.RUNNER_GROUP_ID ?? '1');
const DEFAULT_SCOPE = process.env.RUNNER_SCOPE ?? 'organization'; // fallback if a queued message predates a scope change
const LABEL_PREFIX = process.env.RUNNER_LABEL_PREFIX || 'mvm';

const ssm = new SSMClient({});

function loadParam(name, envLabel) {
  if (!name) return Promise.reject(new Error(`${envLabel} env var is not set`));
  return ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true })).then((res) => {
    const value = res.Parameter?.Value;
    if (!value) throw new Error(`SSM parameter ${name} has no value`);
    return value;
  });
}

let cachedCreds;
const getAppCredentials = () => (cachedCreds ??= loadParam(APP_CREDENTIALS_PARAM, 'GITHUB_APP_CREDENTIALS_PARAM'));

// Warm up during init; no-op catch avoids an init-time unhandledRejection (handler re-awaits).
getAppCredentials().catch(() => undefined);

const microvmConfig = buildMicrovmConfig();

exports.handler = async (event) => {
  const record = event.Records[0];
  const messageId = record.messageId;

  let message;
  try {
    message = JSON.parse(record.body);
  } catch (err) {
    // Malformed JSON - throw so the message is not deleted and eventually redrives to the DLQ.
    console.error(`[${messageId}] Failed to parse SQS message body:`, err);
    throw err;
  }

  const { owner, repo, runId, labels, profile } = message;
  const scope = message.scope ?? DEFAULT_SCOPE;
  const context = {
    runId,
    jobId: message.jobId,
    repo: message.repoFullName,
    workflow: message.workflowName,
    job: message.jobName,
  };
  console.log(
    `[${runId}] Worker received message ${messageId} - scope: ${scope}, target: ${owner}${
      scope === 'repository' ? '/' + repo : ''
    }, profile: ${profile ?? '(none)'}, labels: ${labels.join(', ')}`
  );

  if (typeof microvmConfig === 'string') {
    const configErr = new Error(`MicroVM misconfigured: ${microvmConfig}`);
    console.error(`[${runId}] ${configErr.message}`);
    throw configErr;
  }
  if (scope === 'repository' && !repo) {
    const err = new Error("RUNNER_SCOPE=repository but message has no 'repo' field");
    console.error(`[${runId}] ${err.message}`);
    throw err;
  }
  // Every runner of a profile is registered with exactly these labels - never
  // the job's own labels - so it can only ever take jobs that request this
  // profile, and a job can never take a runner launched for another profile
  // (see resolveProfile in lambda/orchestrator/filter.js).
  const runnerLabels = ['self-hosted', `${LABEL_PREFIX}-${profile}`.toLowerCase()];

  // Checked before minting a JIT config so a routing problem never leaves an
  // orphaned runner registration behind in GitHub.
  const imageIdentifier = imageArnForProfile(profile, microvmConfig);
  if (!imageIdentifier) {
    const err = new Error(
      `No MicroVM image for profile '${profile ?? '(none)'}' - deployed profiles: ${microvmConfig.profiles.join(', ')}`
    );
    console.error(`[${runId}] ${err.message}`);
    putMetric('RunnerLaunchFailures', 1, 'Count', {}, { ...context, profile, stage: 'resolveImage' });
    throw err;
  }

  // Mint the GitHub JIT config, then launch the MicroVM. On any failure, log the stage that
  // was in flight and rethrow so SQS does not delete the message (it becomes visible again
  // after the visibility timeout and eventually redrives to the DLQ after maxReceiveCount).
  let stage = 'getAppCredentials';
  const startedAt = Date.now();
  let t = startedAt;

  try {
    const credsRaw = await getAppCredentials();
    console.log(`[${runId}] getAppCredentials: ${Date.now() - t}ms`);

    stage = 'parseAppCredentials+mintJwt';
    const creds = parseAppCredentials(credsRaw);
    const jwt = mintAppJwt(creds.appClientId, creds.privateKey);

    stage = 'getInstallationToken';
    t = Date.now();
    const token = await getInstallationToken(jwt, creds.installationId);
    console.log(`[${runId}] getInstallationToken: ${Date.now() - t}ms`);

    stage = 'generateJitConfig';
    t = Date.now();
    const runnerName = buildRunnerName(runId);
    const jit =
      scope === 'organization'
        ? await generateOrgJitConfig(token, owner, { name: runnerName, runnerGroupId: RUNNER_GROUP_ID, labels: runnerLabels })
        : await generateRepoJitConfig(token, owner, repo, { name: runnerName, runnerGroupId: RUNNER_GROUP_ID, labels: runnerLabels });
    console.log(`[${runId}] generateJitConfig (${scope}): ${Date.now() - t}ms - JIT runner created:`, JSON.stringify(jit.runner));

    stage = 'runMicrovmWithRetry';
    t = Date.now();
    const logStream = `${profile}/${runnerName}`;
    console.log(`[${runId}] Launching profile '${profile}' image: ${imageIdentifier}`);
    const launchConfig = { ...microvmConfig.base, imageIdentifier, logStream };
    const vm = await runMicrovmWithRetry(launchConfig, jit.encoded_jit_config, { attempts: 3, delayMs: 5000 });
    console.log(
      `[${runId}] runMicrovmWithRetry: ${Date.now() - t}ms total - MicroVM launched: ${vm.microvmId}, endpoint: ${vm.endpoint}`
    );

    // One line per launch tying the GitHub job to its MicroVM and log stream.
    const launched = { ...context, profile, runnerName, microvmId: vm.microvmId, logGroup: microvmConfig.base.logGroup, logStream };
    putMetric('RunnersLaunched', 1, 'Count', { Profile: profile }, launched);
    putMetric('LaunchLatency', Date.now() - startedAt, 'Milliseconds', { Profile: profile }, { runId });
    // Webhook created_at -> RunMicrovm returned: how long the job waited on us
    // before its runner started booting (GitHub's JobQueueTime adds boot +
    // registration on top).
    const createdAtMs = Date.parse(message.createdAt ?? '');
    if (!Number.isNaN(createdAtMs)) {
      putMetric('TimeToRunner', Math.max(0, Date.now() - createdAtMs), 'Milliseconds', { Profile: profile }, { runId });
    }
    console.log(`[${runId}] Worker completed message ${messageId} in ${Date.now() - startedAt}ms`);
  } catch (err) {
    console.error(`[${runId}] Worker failed at stage '${stage}' after ${Date.now() - startedAt}ms`, err);
    putMetric('RunnerLaunchFailures', 1, 'Count', { Profile: profile }, {
      ...context,
      stage,
      errorName: err?.name,
      receiveCount: Number(record.attributes?.ApproximateReceiveCount ?? '1'),
    });
    throw err;
  }
};
