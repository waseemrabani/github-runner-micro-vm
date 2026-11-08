---
name: github-runner-microvm
description: Operate the ephemeral GitHub Actions runner orchestrator on AWS Lambda MicroVMs in this repo - choosing the right `runs-on` labels for a workflow job (arm64 vs x86_64, Docker vs plain, small/medium/large), adding or resizing runner profiles, deploying or upgrading the CloudFormation stacks in the right order, and debugging runners that never start, fail to launch, run out of memory/disk, or land in the DLQ using the project's metrics, alarms and logs. Use this whenever someone works in this repo or asks about these self-hosted runners, MicroVM runner images, runner labels like `mvm-x64-docker-medium` (or the old `lambda-microvms` labels), building Docker images for amd64/arm64 in GitHub Actions on these runners, runner sizing (vCPU/RAM/disk), jobs stuck in "Queued", or the scripts/0*-deploy-*.sh files - even if they don't name the project.
---

# GitHub runners on Lambda MicroVMs

This repo turns each GitHub Actions job into its own short-lived MicroVM: a `workflow_job` webhook → Orchestrator Lambda → SQS → Worker Lambda → `RunMicrovm` → the VM registers as a just-in-time runner, runs exactly one job, and terminates itself. `docs/architecture-overview.svg` (overview) and `docs/architecture.svg` (detailed) show the whole flow; `README.md` is the long-form reference. Read the files named below rather than guessing - the details (label rules, IAM scoping, deploy order) are load-bearing.

## The one idea everything hangs on: runner profiles

A **profile** = CPU architecture × flavor (plain / Docker-in-Docker) × size. Each profile is one `AWS::Lambda::MicrovmImage` named `<ProjectName>-<profile>`, because a MicroVM image has exactly one architecture and one baseline size - neither can change per launch.

- Defined in the `Profiles` mapping at the top of `cloudformation/02-microvm-images.yaml` (`Architecture: ARM_64|X86_64`, `MemoryMiB`).
- Built only if listed in `NO_DOCKER_PROFILES` / `DOCKER_PROFILES` (env vars on `scripts/03-deploy-microvm-images.sh`, remembered in `scripts/.deploy-state.env`). Defaults: `arm64-medium,x64-medium` and `arm64-docker-medium,x64-docker-medium`.
- A job requests profile `P` with the single label `mvm-P` (prefix `RUNNER_LABEL_PREFIX`, default `mvm`).

Sizes use Lambda MicroVMs' baseline/peak model: pick a baseline (2 GB = 1 vCPU), the VM bursts to 4× on demand, you pay baseline while running plus per-second burst. Disk is fixed by tier.

| Size | MemoryMiB | Baseline | Burst peak | Disk |
|---|---|---|---|---|
| small | 2048 | 2 GB / 1 vCPU | 8 GB / 4 vCPU | 8 GB |
| medium | 4096 | 4 GB / 2 vCPU | 16 GB / 8 vCPU | 16 GB |
| large | 8192 | 8 GB / 4 vCPU | 32 GB / 16 vCPU | 32 GB |

## Task: pick `runs-on` for a job

A job uses **exactly one** label, `mvm-<profile>`, plus optionally `self-hosted`, and nothing else:

```yaml
runs-on: [self-hosted, mvm-x64-docker-medium]
```

Why so strict: GitHub hands a queued job to any idle runner whose labels include all of the job's labels. The worker registers every runner with exactly `[self-hosted, mvm-<profile>]`, so a runner only ever takes jobs for its own profile, and no runner carries a shared label a profile-less job could match (that's how a bare `[self-hosted, lambda-microvms]` job once stole a Docker runner). The orchestrator rejects everything else before launching anything - no profile label, the old `lambda-microvms`/`docker` labels, two profile labels, extra labels like `linux`, undeployed profiles - with HTTP 422, an `UnroutableJobs` alarm, and a log line naming the label to use. Same-profile runners are identical, so N jobs get N runners; which runner takes which of them doesn't matter.

Choosing:
1. **Architecture** - match what the job produces or runs. Building a `linux/amd64` image or binary → an `x64-*` profile (native, no QEMU). arm64 otherwise (it's the default and usually cheaper). For multi-arch images, build each arch natively on its own profile and merge with `docker buildx imagetools create` in a follow-up job.
2. **Docker** - only if the job runs `docker`/`docker compose`/buildx or container actions. Docker profiles should be medium or larger: layers and build cache live on the VM's own disk.
3. **Size** - start from what the job needs at peak, remembering burst: "4 vCPU / 14 GB" fits **medium** via burst; choose **large** when it needs that much *sustained* (guaranteed 4 vCPU / 8 GB baseline) or more than 16 GB disk. If there's history, check the sizing data (see Troubleshooting → right-sizing) instead of guessing.
4. **Is it deployed?** Only listed profiles have images. Check `NO_DOCKER_PROFILES` / `DOCKER_PROFILES` in `scripts/.deploy-state.env` (or the `RunnerProfiles` output of the orchestrator stack). If the right profile isn't built, say so and show how to enable it (next task) rather than silently picking a worse one.

## Task: add, enable or resize a profile

1. Existing mapping entry → skip to step 2. New one → add to `Profiles` in `cloudformation/02-microvm-images.yaml`, e.g. `x64-docker-xl: { Architecture: X86_64, MemoryMiB: '8192' }`. Rules: lowercase, unique, ≤ `63 - len(ProjectName)` chars (image name limit 64), `MemoryMiB` one of 512/1024/2048/4096/8192 as a quoted string.
2. Rebuild images with the full new lists (they replace the old lists - removing a profile deletes its image):
   ```bash
   cd scripts
   DOCKER_PROFILES=arm64-docker-medium,x64-docker-medium,x64-docker-xl ./03-deploy-microvm-images.sh both
   ```
3. **Then always** `./04-deploy-orchestrator.sh` - the Lambdas route only the profile names they were deployed with; skipping this makes the new label unroutable.
4. Update the workflows that should use it.

No Lambda or dashboard change is needed: `04-deploy-orchestrator.sh` re-grants IAM on the exact image ARNs and re-deploys the routable label list, the worker derives the ARN from `MICROVM_IMAGE_ARN_PREFIX` + profile, and the dashboard uses `SEARCH`. The new label is `mvm-<new-profile>`. Changing an existing profile's `MemoryMiB` updates its image in place (new version, same label).

## Task: deploy, upgrade, or ship a change

Scripts in `scripts/` are idempotent and share state through `scripts/.deploy-state.env`. Full order for a fresh deploy: `00-create-ssm-params.sh` → `01-deploy-foundation.sh` → `02-package-lambdas.sh` → `03-deploy-microvm-images.sh both` → `04-deploy-orchestrator.sh` → `05-deploy-observability.sh`.

| You changed… | Run |
|---|---|
| `lambda/**` | `02-package-lambdas.sh`, then `04-deploy-orchestrator.sh` (zips use content-hashed S3 keys, so CloudFormation sees new code) |
| `microvm/app.js`, `entrypoint.sh`, a Dockerfile, `microvm/package.json` | `03-deploy-microvm-images.sh <docker|no-docker|both>` |
| Profile lists or the `Profiles` mapping | `03-deploy-microvm-images.sh both`, then `04-deploy-orchestrator.sh` |
| `cloudformation/03-orchestrator.yaml` / its env-var knobs | `04-deploy-orchestrator.sh` |
| `cloudformation/04-observability.yaml`, alarm email/threshold | `05-deploy-observability.sh` |
| Nothing, but AWS deprecated the base image | `03-deploy-microvm-images.sh both` (picks the newest AVAILABLE base image) |
| Nothing, but Ubuntu shipped security fixes | `FORCE_REBUILD=1 ./03-deploy-microvm-images.sh both` - re-runs the Dockerfiles' `apt-get upgrade` (images otherwise only rebuild when their files change) |

Things that bite:
- `02-microvm-images.yaml` uses `Transform: AWS::LanguageExtensions` (`Fn::ForEach`), so deploys need `CAPABILITY_AUTO_EXPAND` - the script passes it; a hand-run `aws cloudformation deploy` must too.
- x86_64 needs MicroVM base image **version 3+**. The images script picks the newest `AVAILABLE` version supporting every arch in `REQUIRED_ARCHS` (default `ARM_64,X86_64`) and fails with a version list if none does - then either wait for the Region or run arm64-only with `REQUIRED_ARCHS=ARM_64`.
- Both Dockerfiles are `FROM ubuntu:26.04` and `apt-get upgrade` before anything else. Keep that first, and keep package names valid for 26.04 (several libraries carry the `t64` suffix, e.g. `libreadline8t64`); the Docker apt source uses the release codename from `/etc/os-release`, not a hardcoded one.
- Both Dockerfiles detect the build architecture (`/etc/runner-arch.env`). Any new download must use those variables (`AWSCLI_ARCH`, `RUNNER_ARCH`, `PYTHON_ARCH`, or `dpkg --print-architecture`) - a hardcoded `aarch64`/`x64` URL breaks the other architecture's build with `Exec format error`.
- Validate locally before deploying: `cfn-lint --ignore-checks E3006 W3037 -- cloudformation/*.yaml` (those two checks only flag that cfn-lint doesn't know the MicroVM resource/actions yet), `shellcheck -x -e SC1091,SC2034 scripts/*.sh`, `(cd lambda/orchestrator && node --test)`.

## Task: debug a runner problem

Start from the symptom; `references/troubleshooting.md` has the full runbook with Logs Insights queries and CLI commands. Quick map:

| Symptom | First check |
|---|---|
| Job sits in "Queued" forever, nothing launched | Profile labels: `UnroutableJobs` alarm / orchestrator log `Cannot route job`, and the App's webhook deliveries (422 = label problem, 401 = secret mismatch, none = App not subscribed to Workflow jobs or not installed on the repo) |
| Webhook 202 but no runner | Worker log `Worker failed at stage '<stage>'`, `RunnerLaunchFailures`, DLQ depth |
| Runner started, job failed oddly | VM log stream `<profile>/gh-runner-<run_id>-*` in `/aws/lambda-microvms/<ProjectName>` |
| OOM / "No space left on device" / slow | `job_summary` peaks vs the profile's baseline and disk → move up a size |
| Slow to start | `JobQueueTime` vs `TimeToRunner` on the dashboard tells you whether it's our pipeline or VM boot/registration |

Everything is joinable on the GitHub **run id**: it's in every Lambda log line (`runId`), in the runner name (`gh-runner-<run_id>-<suffix>`), and therefore in the VM's log stream name.

## Guardrails

- Never log or print the webhook secret, the App private key, installation tokens, or `encoded_jit_config` / the run-hook payload - existing code logs only error *types* on those paths on purpose. Keep it that way in any change.
- Don't widen IAM to `*` to fix an AccessDenied; the scoping (`microvm-image:<ProjectName>-*`, `cloudwatch:namespace` condition, the single execution role for `iam:PassRole`) is deliberate - find which resource/condition doesn't match.
- Deploy commands change real AWS infrastructure and can delete images (removing a profile, or the first upgrade from the two-image version). Show the command and what it will change, and let the user run or approve it.
