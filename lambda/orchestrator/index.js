'use strict';

const crypto = require('node:crypto');
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');
const { parseWorkflowJobEvent, matchesRunnerRequest, resolveTarget } = require('./filter');

const WEBHOOK_SECRET_PARAM = process.env.WEBHOOK_SECRET_PARAM;
const REQUIRED_LABEL = process.env.REQUIRED_RUNNER_LABEL ?? 'lambda-microvms';
const QUEUE_URL = process.env.QUEUE_URL;
const RUNNER_SCOPE = process.env.RUNNER_SCOPE ?? 'organization'; // 'organization' | 'repository'

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

exports.handler = async (event) => {
  // 1. Verify HMAC signature before touching anything else in the request.
  let secret;
  try {
    secret = await getWebhookSecret();
  } catch (err) {
    console.error('Failed to load webhook secret:', err);
    return reply(500, 'secret unavailable');
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
    return reply(400, 'invalid json');
  }
  const match = matchesRunnerRequest(parsed, REQUIRED_LABEL);
  if (!match.matched) {
    console.log(`Ignoring workflow_job event: ${match.reason}`);
    return reply(200, 'ignored');
  }
  console.log(`Matched runner request: ${match.reason}`);

  // 4. Resolve the org/repo the JIT runner should register against.
  const target = resolveTarget(parsed, RUNNER_SCOPE);
  if (!target.ok) {
    console.error(`Cannot resolve JIT target for RUNNER_SCOPE=${RUNNER_SCOPE}: ${target.reason}`);
    return reply(422, 'cannot resolve org/repo for configured RUNNER_SCOPE');
  }

  // 5. Enqueue the runner request for async processing by the worker Lambda.
  const runId = parsed.workflow_job?.run_id;
  const labels = parsed.workflow_job?.labels ?? [REQUIRED_LABEL];

  if (!QUEUE_URL) {
    console.error('QUEUE_URL env var is not set');
    return reply(500, 'queue not configured');
  }

  const message = { scope: RUNNER_SCOPE, owner: target.owner, repo: target.repo, runId, labels };
  try {
    const result = await sqs.send(
      new SendMessageCommand({ QueueUrl: QUEUE_URL, MessageBody: JSON.stringify(message) })
    );
    console.log(
      `[${runId}] Enqueued runner request (${RUNNER_SCOPE}) for '${target.owner}${
        RUNNER_SCOPE === 'repository' ? '/' + target.repo : ''
      }', labels: ${labels.join(', ')} - MessageId: ${result.MessageId}`
    );
    return reply(202, 'queued');
  } catch (err) {
    console.error(`[${runId}] Failed to enqueue runner request:`, err);
    return reply(500, 'enqueue failed');
  }
};
