// Lambda MicroVM lifecycle hook server for the ephemeral GitHub Actions runner.
// Listens on port 9000 for the /ready, /run and /terminate hooks (see the
// Hooks property on the AWS::Lambda::MicrovmImage resources in
// cloudformation/02-microvm-images.yaml for how these are registered
// against the image), and on 8080 as a harmless catch-all (useful when
// poking the image manually while iterating on it).
'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const { spawn, execFile } = require('child_process');
const zlib = require('zlib');
const { LambdaMicrovmsClient, TerminateMicrovmCommand } = require('@aws-sdk/client-lambda-microvms');
const { CloudWatchClient, PutMetricDataCommand } = require('@aws-sdk/client-cloudwatch');

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

// ── Resource usage sampling ───────────────────────────────────────────────
// Lambda MicroVMs publishes no CPU/memory metrics of its own, and a
// profile's size is fixed per image - so to tell whether jobs need a bigger
// (or smaller) profile, sample usage here while the job runs and publish it
// per profile. RUNNER_PROFILE and RUNNER_METRICS_NAMESPACE come from the
// image's EnvironmentVariables (cloudformation/02-microvm-images.yaml).
// Sampling starts at /run, not at boot, so the snapshot build is never
// measured. Nothing here is allowed to affect the job: every failure is
// logged and swallowed.
const PROFILE = process.env.RUNNER_PROFILE || 'unknown';
const METRICS_NAMESPACE = process.env.RUNNER_METRICS_NAMESPACE;
const SAMPLE_INTERVAL_MS = 5_000;
const PUBLISH_INTERVAL_MS = 60_000;
const FINAL_PUBLISH_TIMEOUT_MS = 5_000;
const MIB = 1024 * 1024;

let cloudWatch;
function getCloudWatch() {
  const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;
  return (cloudWatch ??= new CloudWatchClient(region ? { region } : {}));
}

// Aggregate jiffies across every vCPU the guest sees (first line of
// /proc/stat: user nice system idle iowait irq softirq steal ...).
function readCpuTimes() {
  const fields = fs.readFileSync('/proc/stat', 'utf8').split('\n', 1)[0].trim().split(/\s+/).slice(1).map(Number);
  return { idle: fields[3] + (fields[4] || 0), total: fields.slice(0, 8).reduce((a, b) => a + (b || 0), 0) };
}

function readMemoryMiB() {
  const info = fs.readFileSync('/proc/meminfo', 'utf8');
  const kib = (key) => Number(new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(info)?.[1]);
  return { used: (kib('MemTotal') - kib('MemAvailable')) / 1024, total: kib('MemTotal') / 1024 };
}

// Docker image layers and build cache live under /var/lib/docker on the same
// root filesystem, so this is what fills up on undersized Docker profiles.
function readDiskMiB() {
  const s = fs.statfsSync('/');
  return { used: ((s.blocks - s.bfree) * s.bsize) / MIB, total: (s.blocks * s.bsize) / MIB };
}

const round = (n) => Math.round(n * 100) / 100;

async function putMetrics(metrics) {
  if (!METRICS_NAMESPACE) return;
  const dims = [{ Name: 'Profile', Value: PROFILE }];
  const now = new Date();
  const data = metrics
    .filter((m) => m.values.length > 0)
    .map((m) => ({ MetricName: m.name, Unit: m.unit, Dimensions: dims, Timestamp: now, Values: m.values.map(round) }));
  if (data.length === 0) return;
  await getCloudWatch().send(new PutMetricDataCommand({ Namespace: METRICS_NAMESPACE, MetricData: data }));
}

/**
 * Samples every SAMPLE_INTERVAL_MS and publishes the raw samples once a
 * minute (PutMetricData's Values[] keeps them as a distribution, so Maximum
 * and percentiles stay exact), then a per-job peak of each on stop().
 */
function startResourceSampler() {
  const cpuCount = os.cpus().length;
  const pending = { cpu: [], mem: [], disk: [] };
  const peak = { cpu: 0, mem: 0, disk: 0 };
  let totals = { mem: 0, disk: 0 };
  let prevCpu;
  let warned = false;

  const warnOnce = (what, err) => {
    if (warned) return;
    warned = true;
    console.warn(`Resource sampler: ${what} failed (further errors suppressed):`, err && err.message ? err.message : err);
  };

  const sample = () => {
    try {
      const cpu = readCpuTimes();
      if (prevCpu && cpu.total > prevCpu.total) {
        const busy = 1 - (cpu.idle - prevCpu.idle) / (cpu.total - prevCpu.total);
        const cores = Math.max(0, busy * cpuCount);
        pending.cpu.push(cores);
        peak.cpu = Math.max(peak.cpu, cores);
      }
      prevCpu = cpu;
      const mem = readMemoryMiB();
      const disk = readDiskMiB();
      pending.mem.push(mem.used);
      pending.disk.push(disk.used);
      peak.mem = Math.max(peak.mem, mem.used);
      peak.disk = Math.max(peak.disk, disk.used);
      totals = { mem: mem.total, disk: disk.total };
    } catch (err) {
      warnOnce('sampling', err);
    }
  };

  const publish = () =>
    putMetrics([
      { name: 'CpuCoresUsed', unit: 'None', values: pending.cpu.splice(0) },
      { name: 'MemoryUsedMiB', unit: 'Megabytes', values: pending.mem.splice(0) },
      { name: 'DiskUsedMiB', unit: 'Megabytes', values: pending.disk.splice(0) },
    ]).catch((err) => warnOnce('PutMetricData', err));

  sample();
  const sampleTimer = setInterval(sample, SAMPLE_INTERVAL_MS);
  const publishTimer = setInterval(publish, PUBLISH_INTERVAL_MS);

  return {
    /** Stop sampling, flush, and return the job's peaks. Never throws. */
    async stop() {
      clearInterval(sampleTimer);
      clearInterval(publishTimer);
      sample();
      const flush = Promise.all([
        publish(),
        putMetrics([
          { name: 'JobPeakCpuCores', unit: 'None', values: [peak.cpu] },
          { name: 'JobPeakMemoryMiB', unit: 'Megabytes', values: [peak.mem] },
          { name: 'JobPeakDiskMiB', unit: 'Megabytes', values: [peak.disk] },
        ]).catch((err) => warnOnce('PutMetricData', err)),
      ]);
      await Promise.race([flush, new Promise((resolve) => setTimeout(resolve, FINAL_PUBLISH_TIMEOUT_MS))]);
      return {
        vcpusVisible: cpuCount,
        memoryTotalMiB: Math.round(totals.mem),
        diskTotalMiB: Math.round(totals.disk),
        peakCpuCores: round(peak.cpu),
        peakMemoryMiB: Math.round(peak.mem),
        peakDiskMiB: Math.round(peak.disk),
      };
    },
  };
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
      const jobStartedAt = Date.now();
      const sampler = startResourceSampler();

      child.on('exit', async (code, signal) => {
        console.log(`Runner process exited - code: ${code ?? '(null)'}, signal: ${signal ?? '(null)'}`);
        const usage = await sampler.stop();
        // One JSON line per job - query across the fleet with Logs Insights,
        // e.g. `filter event = "job_summary" | stats max(peakMemoryMiB) by profile`.
        console.log(
          JSON.stringify({
            event: 'job_summary',
            profile: PROFILE,
            runnerName,
            microvmId,
            arch: os.arch(),
            exitCode: code,
            signal,
            durationSeconds: Math.round((Date.now() - jobStartedAt) / 1000),
            ...usage,
          })
        );
        await terminateSelf(microvmId);
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
