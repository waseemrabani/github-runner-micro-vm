// Lambda MicroVM lifecycle hook server for the ephemeral GitHub Actions runner.
// Listens on port 9000 for the /ready, /run and /terminate hooks (see the
// Hooks property on the AWS::Lambda::MicrovmImage resources in
// cloudformation/02-microvm-images.yaml for how these are registered
// against the image), and on 8080 as a harmless catch-all (useful when
// poking the image manually while iterating on it).
'use strict';

const http = require('http');
const { spawn, execFile } = require('child_process');
const zlib = require('zlib');
const { LambdaMicrovmsClient, TerminateMicrovmCommand } = require('@aws-sdk/client-lambda-microvms');

// Stored after the /run hook fires - used only for logging.
let runnerName = null;

// ── Docker-in-Docker (snapshot-warmed) ────────────────────────────────────
// HAS_DOCKER is true only when the image was built from Dockerfile.docker
// (which sets ENV RUNNER_HAS_DOCKER=1). For the plain flavor (Dockerfile.base)
// dockerState is pre-set to 'ready', so /ready returns 200 immediately and
// dockerd/dnsmasq are never started.
//
// The daemon is started here, in the CMD process (app.js), rather than in
// entrypoint.sh at job time: Lambda MicroVMs snapshots the full memory state
// of the CMD/ENTRYPOINT process tree the instant /ready returns 200. A daemon
// that is already up and warm at that moment is captured in the snapshot and
// restored pre-warmed on every subsequent run - shaving several seconds of
// dockerd startup off every job. A process started from a Dockerfile RUN step
// would NOT be captured this way: only the live CMD/ENTRYPOINT process tree at
// snapshot time is frozen, not ephemeral build-layer processes.
const HAS_DOCKER = process.env.RUNNER_HAS_DOCKER === '1';

let dockerState = HAS_DOCKER ? 'starting' : 'ready'; // 'starting' | 'ready' | 'failed'
const DOCKER_READY_DEADLINE_MS = 50_000; // stay well within the image's readyTimeoutInSeconds

function startDockerDaemon() {
  // --dns 172.17.0.1 makes every container (including nested `docker build`
  // steps) use the dnsmasq forwarder on the docker0 bridge gateway as its
  // resolver. Without this flag, Docker falls back to the host's
  // /etc/resolv.conf, which inside a Lambda MicroVM only contains the
  // loopback address 127.0.0.2 - unreachable from inside a container's own
  // network namespace.
  const daemon = spawn('dockerd', ['--dns', '172.17.0.1'], { stdio: ['ignore', 'inherit', 'inherit'] });
  daemon.on('error', (err) => {
    console.error('Failed to spawn dockerd:', err);
    dockerState = 'failed';
  });
  daemon.on('exit', (code, signal) => {
    console.error(`dockerd exited - code: ${code ?? '(null)'}, signal: ${signal ?? '(null)'}`);
    if (dockerState !== 'ready') dockerState = 'failed';
  });

  const start = Date.now();
  const poll = () => {
    execFile('docker', ['info'], (err) => {
      if (!err) {
        dockerState = 'ready';
        console.log('Docker daemon is ready.');
        return;
      }
      if (Date.now() - start > DOCKER_READY_DEADLINE_MS) {
        dockerState = 'failed';
        console.error('Docker daemon did not become ready in time - proceeding without it. Jobs that require Docker may fail.');
        return;
      }
      setTimeout(poll, 1000);
    });
  };
  poll();
}

// ── DNS forwarder (snapshot-warmed) ───────────────────────────────────────
// Lambda's DNS proxy binds to the loopback address 127.0.0.2 in
// /etc/resolv.conf, which is unreachable from inside a Docker container's own
// network namespace. Docker detects loopback nameservers, strips them, and
// falls back to the hardcoded 8.8.8.8/8.8.4.4 - which fails in accounts that
// route MicroVM egress through a VPC connector without public DNS access.
//
// Fix: dnsmasq listens on 172.17.0.1 (the docker0 bridge gateway, reachable
// from every container), forwards to 127.0.0.2, and dockerd is started with
// --dns 172.17.0.1 so every container is handed this resolver.
//
// Like dockerd, dnsmasq must be spawned from the CMD process tree to be
// captured in the snapshot. --bind-dynamic lets it start before docker0
// exists and bind to it once dockerd creates the bridge.
function startDnsmasq() {
  const proc = spawn(
    'dnsmasq',
    [
      '--keep-in-foreground', // stay a foreground child process (no daemonize); captured in the snapshot
      '--bind-dynamic', // bind 172.17.0.1 lazily once docker0 appears
      '--listen-address=172.17.0.1',
      // upstream: dnsmasq reads /etc/resolv.conf by default, picking up 127.0.0.2 automatically
    ],
    { stdio: ['ignore', 'inherit', 'inherit'] }
  );
  proc.on('error', (err) => console.error('Failed to spawn dnsmasq:', err));
  proc.on('exit', (code, signal) =>
    console.error(`dnsmasq exited - code: ${code ?? '(null)'}, signal: ${signal ?? '(null)'}`)
  );
  console.log('dnsmasq forwarder started (172.17.0.1 -> 127.0.0.2 via /etc/resolv.conf)');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

function runnerNameFromJitConfig(encodedJitConfig) {
  const outer = JSON.parse(Buffer.from(encodedJitConfig, 'base64').toString('utf8'));
  const runner = JSON.parse(Buffer.from(outer['.runner'], 'base64').toString('utf8'));
  return runner.AgentName;
}

// The run-hook payload is either (a) the plain encoded_jit_config (a base64
// string), or (b) base64(gzip(encoded_jit_config)) - the worker Lambda
// (lambda/worker/microvms.js) always sends (b) because encoded_jit_config can
// run close to RunMicrovm's 4096-char runHookPayload cap. Gzip magic bytes
// (0x1f 0x8b) after the outer base64 decode are detected and decompressed.
function decodeJitConfig(payload) {
  const buf = Buffer.from(payload, 'base64');
  if (buf[0] === 0x1f && buf[1] === 0x8b) {
    return zlib.gunzipSync(buf).toString('utf8');
  }
  return payload;
}

// Calls TerminateMicrovm so the platform tears the VM down promptly once the
// runner process exits, instead of waiting out the idle policy. Credentials
// come from the execution role via IMDSv2 - the AWS SDK's default credential
// chain picks these up automatically inside the guest, no explicit config
// needed. A failed terminate call is logged but not fatal: the idlePolicy's
// maxIdleDurationSeconds is the fallback.
async function terminateSelf(microvmId) {
  if (!microvmId) {
    console.warn('Warning: microvmId is missing - skipping self-termination');
    return;
  }
  const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;
  const client = new LambdaMicrovmsClient(region ? { region } : {});
  try {
    await client.send(new TerminateMicrovmCommand({ microvmIdentifier: microvmId }));
    console.log('TerminateMicrovm succeeded for:', microvmId);
  } catch (err) {
    console.error('TerminateMicrovm failed for:', microvmId, err);
  }
}

async function handleRequest(req, res) {
  const { method, url } = req;
  console.log(`${new Date().toISOString()} ${method} ${url}`);

  // POST /aws/lambda-microvms/runtime/v1/ready
  // Required during image build so Lambda knows the app has booted and it is
  // safe to snapshot. Gated on the Docker daemon being ready (docker flavor
  // only) so dockerd is captured warm in the snapshot: return 503 while
  // starting (Lambda retries until readyTimeoutInSeconds), 200 once settled.
  // A docker startup failure still returns 200 (best-effort) so non-docker
  // jobs on the docker image are never blocked by a broken daemon.
  if (method === 'POST' && url === '/aws/lambda-microvms/runtime/v1/ready') {
    if (dockerState === 'starting') {
      res.writeHead(503);
      res.end();
      return;
    }
    res.writeHead(200);
    res.end();
    return;
  }

  // POST /aws/lambda-microvms/runtime/v1/run
  // Receives the per-instance JIT config, derives the runner name for
  // logging, and spawns entrypoint.sh. When the runner process exits
  // (regardless of exit code or signal) we call terminateSelf() so the VM
  // tears down immediately rather than waiting for the idle policy.
  if (method === 'POST' && url === '/aws/lambda-microvms/runtime/v1/run') {
    try {
      const body = await readBody(req);
      const { microvmId, runHookPayload } = JSON.parse(body);
      const encodedJitConfig = decodeJitConfig(runHookPayload);

      runnerName = runnerNameFromJitConfig(encodedJitConfig);
      console.log('MicroVM ID:', microvmId ?? '(unknown)');
      console.log('Runner name from JIT config:', runnerName);

      const child = spawn('./entrypoint.sh', [], {
        stdio: 'inherit',
        env: { ...process.env, ENCODED_JIT_CONFIG: encodedJitConfig },
      });

      child.on('exit', (code, signal) => {
        console.log(`Runner process exited - code: ${code ?? '(null)'}, signal: ${signal ?? '(null)'}`);
        terminateSelf(microvmId);
      });

      res.writeHead(200);
      res.end();
    } catch (err) {
      // Never log `err` directly here: a JSON/base64 parse failure can embed
      // fragments of the run-hook payload - which carries the JIT runner
      // registration credential - in its message. Log only the error type so
      // the credential can never reach CloudWatch.
      console.error('Error handling /run:', err && err.name ? err.name : 'unknown error');
      res.writeHead(500);
      res.end();
    }
    return;
  }

  // POST /aws/lambda-microvms/runtime/v1/terminate
  // Fired by the platform after app.js itself called TerminateMicrovm on
  // child exit. The JIT runner has already auto-deregistered from GitHub
  // (ephemeral runners deregister themselves after the job completes), so
  // there is nothing left to clean up here - just acknowledge.
  if (method === 'POST' && url === '/aws/lambda-microvms/runtime/v1/terminate') {
    console.log('Terminate received for runner:', runnerName ?? '(unknown)');
    res.writeHead(200);
    res.end();
    return;
  }

  // Catch-all - useful when poking the image manually while iterating on it.
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok', path: url }));
}

// Start the Docker daemon and the dnsmasq DNS forwarder now, before /ready is
// answered, so both are warm and captured in the snapshot. dockerd creates
// the docker0 bridge that dnsmasq listens on; dnsmasq's --bind-dynamic flag
// lets it start immediately and bind once docker0 appears, so no explicit
// ordering wait is needed beyond starting dockerd first.
if (HAS_DOCKER) {
  startDockerDaemon();
  startDnsmasq();
}

// Both ports share the same handler: 8080 is a manual-poke catch-all, 9000 is
// where the platform sends all lifecycle hook requests.
for (const port of [8080, 9000]) {
  http.createServer(handleRequest).listen(port, '0.0.0.0', () => {
    console.log(`Listening on 0.0.0.0:${port}`);
  });
}
