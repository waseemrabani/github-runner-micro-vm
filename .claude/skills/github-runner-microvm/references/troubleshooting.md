# Troubleshooting runbook

Replace `P` with the ProjectName (default `github-runner-orchestrator`) and set `--region`. Every log line below is emitted by code in this repo, so `grep` the repo for the quoted text to see exactly where.

Contents: 1. Where things are · 2. Job stuck in Queued · 3. Launch failures / DLQ · 4. Inside the VM · 5. Right-sizing · 6. Image build failures · 7. Slow starts

## 1. Where things are

| What | Where |
|---|---|
| Webhook receiver logs | `/aws/lambda/P-orchestrator` |
| Worker logs | `/aws/lambda/P-worker` |
| Every MicroVM's build + runtime output | `/aws/lambda-microvms/P`, stream `<profile>/gh-runner-<run_id>-<suffix>` (build logs are in the same group) |
| Custom metrics | Lambda metrics (alarmed): namespace `GitHubRunnerMicroVMs` (`METRICS_NAMESPACE`); in-VM resource metrics: `GitHubRunnerMicroVMs/Runner`. Dimension `Profile` (+ fleet-wide series without it for Lambda metrics) |
| Alarms | `P-dlq-not-empty`, `P-queue-backlog`, `P-runner-launch-failures`, `P-unroutable-jobs`, `P-webhook-errors`, `P-slow-runner-start` → SNS `P-alarms` |
| Dashboard | CloudWatch dashboard `P` |
| Queues | `P-webhook-queue`, `P-webhook-dlq` |
| Deployed profile list | `scripts/.deploy-state.env` (`NO_DOCKER_PROFILES`, `DOCKER_PROFILES`) or orchestrator stack output `RunnerProfiles` |

The Lambda metric lines are JSON (Embedded Metric Format), so Logs Insights can filter on their fields directly: `runId`, `jobId`, `repo`, `workflow`, `job`, `profile`/`Profile`, `stage`, `errorName`, `microvmId`, `logStream`.

## 2. Job stuck in "Queued", no runner ever appeared

Work down this list; stop at the first hit.

1. **Labels.** The job needs exactly one *deployed* `mvm-<profile>` label, optionally `self-hosted`, and nothing else. Common misses: the old `lambda-microvms` / `docker` / bare-profile labels, a typo, two profile labels, extra labels like `linux`, or a profile that exists in the mapping but isn't in the deployed lists (or `04-deploy-orchestrator.sh` wasn't re-run after `03`).
   ```
   # /aws/lambda/P-orchestrator
   filter @message like /Cannot route job/ | fields @timestamp, @message | sort @timestamp desc | limit 20
   ```
   The reason text says which case it is. Fix the workflow's `runs-on`, or enable the profile (SKILL.md → add a profile).
2. **Webhook never arrived / rejected.** GitHub → the App's settings → Advanced → Recent Deliveries. `401 invalid signature` = webhook secret in GitHub ≠ SSM `/P/webhook-secret` (`InvalidSignatures` metric climbs). No deliveries at all = App not subscribed to **Workflow jobs**, or not installed on that repo. `422 cannot resolve org/repo` = `RunnerScope=organization` but the repo is user-owned.
3. **Accepted (202) but the worker failed** → section 3.
4. **Runner launched but the job still waits** → the VM booted but didn't register: read its log stream (section 4). If the VM log shows `Running job: <a different job>`, that runner took another queued job **of the same profile** - expected and harmless, since that job's own runner then takes this one; only if that other runner failed to launch (section 3, by its run id) does a job stay stuck. A runner can never take a job of another profile or one without a profile label: it is registered with only `[self-hosted, mvm-<profile>]`.

## 3. Launch failures and the DLQ

```
# /aws/lambda/P-worker
filter RunnerLaunchFailures > 0
| fields @timestamp, runId, repo, job, profile, Profile, stage, errorName, receiveCount
| sort @timestamp desc | limit 50
```

| `stage` | Usual cause |
|---|---|
| `resolveImage` | Message's profile has no image in this deployment - profile removed after the job queued, or orchestrator and images stacks out of sync. Re-run `03` then `04`. |
| `getAppCredentials` / `parseAppCredentials+mintJwt` | SSM `/P/app-credentials` missing or malformed - re-run `00-create-ssm-params.sh`. |
| `getInstallationToken` | Wrong installation id, App uninstalled, or private key rotated. |
| `generateJitConfig` | App lacks the permission for the scope (org: Self-hosted runners R/W; repo: Administration R/W), or wrong `RUNNER_GROUP_ID`. The error text has GitHub's response. |
| `runMicrovmWithRetry` | See `errorName`: `AccessDeniedException` (IAM - `RunMicrovm` is granted on the exact `RunnerImageArns`, so a profile added without re-running `04-deploy-orchestrator.sh` is denied; also check `PassRole` / `PassNetworkConnector`), `ResourceNotFoundException` (image name ≠ `P-<profile>`), `ValidationException` (image/version not ACTIVE - a failed build), `ServiceQuotaExceededException` / `InsufficientCapacityException` / `ThrottlingException` (concurrency or memory quota - Service Quotas console, or fewer/smaller concurrent jobs). |

After 3 failed attempts a message moves to `P-webhook-dlq`. Fix the cause, then redrive from the SQS console (DLQ → Start DLQ redrive). Note each failed attempt *after* `generateJitConfig` leaves an unused JIT registration in GitHub; GitHub cleans those up on its own.

## 4. Inside the VM

Find the stream from the run id (`<profile>/gh-runner-<run_id>-*`), or from the worker's `RunnersLaunched` line, which carries `logStream` and `microvmId`.

Useful lines in that stream:
- `Runner name from JIT config:` - /run hook fired; runner starting.
- GitHub runner output (`Listening for Jobs`, `Running job:`, `Job ... completed with result:`).
- `Runner process exited - code: X` then the `{"event":"job_summary",...}` line with peaks.
- `TerminateMicrovm failed` - self-termination failed; the VM lives until `MicrovmMaxIdleSeconds`/`MicrovmMaxDurationSeconds`. Usually the execution role's `SelfTerminate` resources.
- `Docker daemon did not become ready in time` (Docker profiles, during the image build) - Docker jobs on that image will fail; check the build log for dockerd errors.
- `Resource sampler: ... failed` - metrics only; never affects the job. `PutMetricData` failures usually mean `METRICS_NAMESPACE` differs between the images and orchestrator stacks (the IAM condition pins the role to `<METRICS_NAMESPACE>/Runner`).

A job killed at exactly `MicrovmMaxDurationSeconds` (default 3600) hit the platform's hard ceiling - raise it (max 28800) on the orchestrator stack.

## 5. Right-sizing

```
# /aws/lambda-microvms/P
filter event = "job_summary"
| stats count() as jobs, pct(peakMemoryMiB, 90) as p90MemMiB, max(peakMemoryMiB) as maxMemMiB,
        pct(peakCpuCores, 90) as p90Cpu, max(peakDiskMiB) as maxDiskMiB, avg(durationSeconds) as avgSecs by profile
```

Read against the size table in SKILL.md:
- p90 memory or CPU regularly **above baseline** → the job lives on burst (billed per second above baseline). Fine if occasional; if constant, the next size up may cost about the same and is more predictable.
- max memory near the **peak** (4× baseline), OOM kills, or `maxDiskMiB` near disk total (`diskTotalMiB` in the summary) → move up a size; for Docker, disk is usually the first limit.
- p90 well under half the baseline → move down a size and save the baseline cost on every job.

`vcpusVisible`/`memoryTotalMiB` in the summary show what the guest sees (the burst ceiling), not the baseline.

## 6. Image build failures (`03-deploy-microvm-images.sh`)

- Stack event says the image is `CREATE_FAILED`/`UPDATE_FAILED`: read the build output in `/aws/lambda-microvms/P` (base image v2+ streams it live). Also `aws lambda-microvms list-microvm-image-builds --image-identifier P-<profile>`.
- `Exec format error` or a 404 on a download: an architecture-specific URL that ignores `/etc/runner-arch.env`.
- `ValidationException` about the architecture: the pinned base image version doesn't support it - re-run the script (it picks a compatible version) or check `REQUIRED_ARCHS`.
- `/ready` timeout (180 s): `app.js` never returned 200 - for Docker images, dockerd failed to start.

## 7. Slow starts

Dashboard: `JobQueueTime` (GitHub queued → started, end to end) vs `TimeToRunner` (queued → `RunMicrovm` returned).
- `TimeToRunner` high → our pipeline: queue backlog (`ApproximateAgeOfOldestMessage`), worker throttles, retries in `runMicrovmWithRetry` (5 s apart), slow GitHub API.
- `TimeToRunner` low but `JobQueueTime` high → VM boot + runner registration: check the VM log timestamps between the /run hook and `Listening for Jobs`.
