'use strict';

const crypto = require('node:crypto');
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');
const { parseWorkflowJobEvent, resolveTarget, resolveProfile, elapsedMs } = require('./filter');
const { putMetric } = require('./metrics');

const WEBHOOK_SECRET_PARAM = process.env.WEBHOOK_SECRET_PARAM;
const LABEL_PREFIX = process.env.RUNNER_LABEL_PREFIX || 'mvm';
const QUEUE_URL = process.env.QUEUE_URL;
const RUNNER_SCOPE = process.env.RUNNER_SCOPE ?? 'organization'; // 'organization' | 'repository'
const RUNNER_PROFILES = (process.env.RUNNER_PROFILES ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const ssm = new SSMClient({});
const sqs = new SQSClient({});

function loadParam(name, envLabel) {
  if (!name) return Promise.reject(new Error(`${envLabel} env var is not set`));
  return ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true })).then((res) => {
    const value = res.Parameter?.Value;
    if (!value) throw new Error(`SSM parameter ${name} has no value`);
    return value;
  });
}

// Cached across warm invocations; loaded once per cold start.
let cachedSecret;
const getWebhookSecret = () => (cachedSecret ??= loadParam(WEBHOOK_SECRET_PARAM, 'WEBHOOK_SECRET_PARAM'));

// Warm up during init so the common case (warm invoke) never pays the SSM round trip.
// The no-op catch here prevents an init-time unhandledRejection; the handler re-awaits
// and handles the real error.
getWebhookSecret().catch(() => undefined);

const reply = (statusCode, body) => ({ statusCode, body });

function replyError(statusCode, body) {
  putMetric('WebhookErrors', 1, 'Count');
  return reply(statusCode, body);
}

/**
 * in_progress / completed events for our own jobs carry no work for us, but
 * they are the only place GitHub reports how long a job actually waited for
 * a runner and how it ended - so turn them into metrics.
 */
function recordJobLifecycle(event, route) {
  const job = event.workflow_job ?? {};
  const dims = route.ok ? { Profile: route.profile } : {};
  const props = {
    runId: job.run_id,
    jobId: job.id,
    repo: event.repository?.full_name,
    workflow: job.workflow_name,
    job: job.name,
    runnerName: job.runner_name,
  };

  if (event.action === 'in_progress') {
    const queueMs = elapsedMs(job.created_at, job.started_at);
    if (queueMs !== undefined) putMetric('JobQueueTime', queueMs, 'Milliseconds', dims, props);
    return;
  }

  if (event.action === 'completed') {
    const conclusion = job.conclusion ?? 'unknown';
    putMetric('JobsCompleted', 1, 'Count', { ...dims, Conclusion: conclusion }, props);
    // A job cancelled while still queued never reached a runner (no
    // runner_name) - its "duration" would be queue time, not run time.
    const runMs = job.runner_name ? elapsedMs(job.started_at, job.completed_at) : undefined;
    if (runMs !== undefined) putMetric('JobDuration', runMs, 'Milliseconds', dims, props);
  }
}

exports.handler = async (event) => {
  // 1. Verify HMAC signature before touching anything else in the request.
  let secret;
  try {
    secret = await getWebhookSecret();
  } catch (err) {
    console.error('Failed to load webhook secret:', err);
    return replyError(500, 'secret unavailable');
  }

  const rawBody = event.body
    ? Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8')
    : Buffer.alloc(0);
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const received = Buffer.from(event.headers?.['x-hub-signature-256'] ?? '');
  const expectedBuf = Buffer.from(expected);
  const signatureOk =
    received.length === expectedBuf.length && crypto.timingSafeEqual(received, expectedBuf);
  if (!signatureOk) {
    console.warn('Rejected webhook: invalid or missing signature');
    putMetric('InvalidSignatures', 1, 'Count');
    return reply(401, 'invalid signature');
  }

  // 2. Only act on workflow_job events (ping and everything else is ack'd + ignored).
  const eventType = event.headers?.['x-github-event'];
  if (eventType !== 'workflow_job') {
    console.log(`Ignoring event type '${eventType ?? '(none)'}' (not workflow_job)`);
    return reply(200, 'ignored');
  }

  // 3. Parse + filter.
  let parsed;
  try {
    parsed = parseWorkflowJobEvent(rawBody.toString('utf8'));
  } catch (err) {
    console.error('Failed to parse webhook body as JSON:', err);
    return replyError(400, 'invalid json');
  }

  const runId = parsed.workflow_job?.run_id;
  const labels = parsed.workflow_job?.labels ?? [];

  // 4. Is this job for us, and which runner profile (CPU architecture x
  // flavor x size) does it get?
  const route = resolveProfile(labels, LABEL_PREFIX, RUNNER_PROFILES);
  if (!route.ours) {
    console.log(`Ignoring workflow_job event: labels [${labels.join(', ')}] request no '${LABEL_PREFIX}-*' runner`);
    return reply(200, 'ignored');
  }
  if (parsed.action !== 'queued') {
    recordJobLifecycle(parsed, route);
    return reply(200, 'recorded');
  }
  // A 422 shows up as a failed delivery in GitHub's webhook UI, next to the job.
  if (!route.ok) {
    console.warn(`[${runId}] Cannot route job: ${route.reason}`);
    putMetric('UnroutableJobs', 1, 'Count', {}, { runId, repo: parsed.repository?.full_name, labels });
    return reply(422, route.reason);
  }
  console.log(`[${runId}] ${route.reason}`);

  // 5. Resolve the org/repo the JIT runner should register against.
  const target = resolveTarget(parsed, RUNNER_SCOPE);
  if (!target.ok) {
    console.error(`Cannot resolve JIT target for RUNNER_SCOPE=${RUNNER_SCOPE}: ${target.reason}`);
    return replyError(422, 'cannot resolve org/repo for configured RUNNER_SCOPE');
  }

  // 6. Enqueue the runner request for async processing by the worker Lambda.
  if (!QUEUE_URL) {
    console.error('QUEUE_URL env var is not set');
    return replyError(500, 'queue not configured');
  }

  const job = parsed.workflow_job ?? {};
  const message = {
    scope: RUNNER_SCOPE,
    owner: target.owner,
    repo: target.repo,
    runId,
    labels,
    profile: route.profile,
    // Context for logs and the worker's TimeToRunner metric only.
    jobId: job.id,
    jobName: job.name,
    workflowName: job.workflow_name,
    repoFullName: parsed.repository?.full_name,
    createdAt: job.created_at,
  };
  try {
    const result = await sqs.send(
      new SendMessageCommand({ QueueUrl: QUEUE_URL, MessageBody: JSON.stringify(message) })
    );
    console.log(
      `[${runId}] Enqueued runner request (${RUNNER_SCOPE}, profile ${route.profile}) for '${target.owner}${
        RUNNER_SCOPE === 'repository' ? '/' + target.repo : ''
      }', labels: ${labels.join(', ')} - MessageId: ${result.MessageId}`
    );
    putMetric('JobsQueued', 1, 'Count', { Profile: route.profile }, { runId, jobId: job.id, repo: message.repoFullName });
    return reply(202, 'queued');
  } catch (err) {
    console.error(`[${runId}] Failed to enqueue runner request:`, err);
    return replyError(500, 'enqueue failed');
  }
};
