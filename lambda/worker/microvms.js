'use strict';

const zlib = require('node:zlib');
const { promisify } = require('node:util');
const { LambdaMicrovmsClient, RunMicrovmCommand } = require('@aws-sdk/client-lambda-microvms');

const client = new LambdaMicrovmsClient({});
const gzipAsync = promisify(zlib.gzip);

/**
 * Pick the runner image by label: opt-in to the Docker-in-Docker image via
 * dockerLabel; everything else gets the plain (no-docker) image.
 */
function selectImageIdentifier(labels, images, dockerLabel) {
  return labels.includes(dockerLabel) ? images.docker : images.noDocker;
}

/** Build a MicrovmConfig from environment variables. Returns an error string if misconfigured. */
function buildMicrovmConfig() {
  const dockerImageIdentifier = process.env.MICROVM_IMAGE_IDENTIFIER_DOCKER;
  const noDockerImageIdentifier = process.env.MICROVM_IMAGE_IDENTIFIER_NO_DOCKER;
  const executionRoleArn = process.env.MICROVM_EXECUTION_ROLE_ARN;
  const ingressRaw = process.env.MICROVM_INGRESS_NETWORK_CONNECTORS;
  const egressRaw = process.env.MICROVM_EGRESS_NETWORK_CONNECTORS;
  if (!dockerImageIdentifier) return 'MICROVM_IMAGE_IDENTIFIER_DOCKER env var is not set';
  if (!noDockerImageIdentifier) return 'MICROVM_IMAGE_IDENTIFIER_NO_DOCKER env var is not set';
  if (!executionRoleArn) return 'MICROVM_EXECUTION_ROLE_ARN env var is not set';
  if (!ingressRaw) return 'MICROVM_INGRESS_NETWORK_CONNECTORS env var is not set';
  if (!egressRaw) return 'MICROVM_EGRESS_NETWORK_CONNECTORS env var is not set';
  return {
    base: {
      executionRoleArn,
      ingressNetworkConnectors: ingressRaw.split(',').map((s) => s.trim()),
      egressNetworkConnectors: egressRaw.split(',').map((s) => s.trim()),
      maxIdleDurationSeconds: Number(process.env.MICROVM_MAX_IDLE_SECONDS ?? '1800'),
      suspendedDurationSeconds: Number(process.env.MICROVM_SUSPENDED_SECONDS ?? '10'),
      maximumDurationInSeconds: Number(process.env.MICROVM_MAX_DURATION_SECONDS ?? '3600'),
    },
    images: { docker: dockerImageIdentifier, noDocker: noDockerImageIdentifier },
    dockerLabel: process.env.DOCKER_RUNNER_LABEL ?? 'docker',
  };
}

/**
 * RunMicrovm's runHookPayload has a hard 4096-char (16384-byte decoded) cap.
 * encoded_jit_config is itself already base64, and can run close to that
 * limit for orgs/repos with many labels, so we gzip it - the /run hook on
 * the MicroVM side (microvm/app.js) detects the gzip magic bytes and
 * decompresses transparently.
 */
async function compressJitConfig(jitConfig) {
  const compressed = await gzipAsync(Buffer.from(jitConfig, 'utf8'));
  return compressed.toString('base64');
}

async function runMicrovm(config, jitConfig) {
  const runHookPayload = await compressJitConfig(jitConfig);

  const res = await client.send(
    new RunMicrovmCommand({
      imageIdentifier: config.imageIdentifier,
      executionRoleArn: config.executionRoleArn,
      ingressNetworkConnectors: config.ingressNetworkConnectors,
      egressNetworkConnectors: config.egressNetworkConnectors,
      idlePolicy: {
        autoResumeEnabled: true,
        maxIdleDurationSeconds: config.maxIdleDurationSeconds,
        suspendedDurationSeconds: config.suspendedDurationSeconds,
      },
      maximumDurationInSeconds: config.maximumDurationInSeconds,
      runHookPayload,
    })
  );

  if (!res.microvmId || !res.endpoint) {
    throw new Error('RunMicrovmCommand returned incomplete response');
  }

  return { microvmId: res.microvmId, endpoint: res.endpoint };
}

/** Launch a MicroVM with up to opts.attempts attempts, sleeping opts.delayMs between failures. */
async function runMicrovmWithRetry(config, jitConfig, opts) {
  let lastErr;
  for (let attempt = 1; attempt <= opts.attempts; attempt++) {
    const t = Date.now();
    try {
      const result = await runMicrovm(config, jitConfig);
      console.log(`runMicrovm attempt ${attempt}/${opts.attempts}: success in ${Date.now() - t}ms`);
      return result;
    } catch (err) {
      lastErr = err;
      console.warn(`runMicrovm attempt ${attempt}/${opts.attempts}: failed after ${Date.now() - t}ms`, err);
      if (attempt < opts.attempts) {
        await new Promise((resolve) => setTimeout(resolve, opts.delayMs));
      }
    }
  }
  throw lastErr;
}

module.exports = { selectImageIdentifier, buildMicrovmConfig, runMicrovm, runMicrovmWithRetry };
