# GitHub Ephemeral Runner Orchestrator (CloudFormation)

Ephemeral, single-use GitHub Actions self-hosted runners on [AWS Lambda MicroVMs](https://docs.aws.amazon.com/lambda/latest/dg/microvms-how-it-works.html), provisioned on demand by a GitHub webhook and deployed with plain **AWS CloudFormation** — no CDK, no CDK toolchain.

When a workflow needs a runner, GitHub sends a `workflow_job` webhook. A fresh MicroVM boots from a pre-built snapshot in a few seconds, registers itself with GitHub as a [just-in-time (JIT) runner](https://docs.github.com/en/rest/actions/self-hosted-runners#create-configuration-for-a-just-in-time-runner-for-an-organization), runs **exactly one job**, and self-terminates. There are no long-lived runners, no shared state between jobs, and no idle compute.

This project is a CloudFormation port of [donkersgoed/github-runner-ochestrator](https://github.com/donkersgoed/github-runner-ochestrator) (CDK), cross-checked against AWS's own [Lambda MicroVMs documentation](https://docs.aws.amazon.com/lambda/latest/dg/microvms-how-it-works.html) and [aws/agent-toolkit-for-aws's `aws-lambda-microvms` skill](https://github.com/aws/agent-toolkit-for-aws/blob/main/skills/specialized-skills/serverless-skills/aws-lambda-microvms/SKILL.md), with two additions:

- **Both org-level and repo-level runners**, selected with a single `RunnerScope` parameter — the reference implementation only supports organization-level runners.
- A couple of IAM corrections found by comparing the reference CDK code against AWS's documented IAM guidance (see [Differences from the reference implementation](#differences-from-the-reference-implementation)).

## Architecture

```
GitHub                 API Gateway         Orchestrator Lambda      SQS            Worker Lambda           Lambda MicroVM
──────                 ───────────         ───────────────────      ───            ─────────────           ──────────────
workflow_job   ──POST──▶  /webhook  ──────▶  verify HMAC        ──▶ queue  ──────▶  mint GitHub JIT   ──▶  boot from snapshot
(queued, has                                 filter action/label                    token (App JWT →         register as JIT runner
required label)                              resolve org/repo                       installation token)      run exactly 1 job
                                              enqueue + 202                          RunMicrovm                self-terminate
                                                                    │
                                                                    ▼
                                                                   DLQ (after 3 failed attempts)
```

1. **GitHub** sends a `workflow_job` webhook (HMAC-SHA256 signed) when a job is queued.
2. **API Gateway** (HTTP API) exposes `POST /webhook` and invokes the Orchestrator Lambda.
3. **Orchestrator Lambda** verifies the webhook signature, filters for queued `workflow_job` events carrying the required label, resolves the org/repo to register against, and enqueues a runner request. It responds in milliseconds so GitHub's webhook delivery never blocks on provisioning.
4. **SQS** decouples acceptance from provisioning and gives you retries plus a dead-letter queue for requests that fail 3 times.
5. **Worker Lambda** consumes the queue, mints a [JIT runner token](https://docs.github.com/en/rest/actions/self-hosted-runners) from your GitHub App, and calls `RunMicrovm`.
6. **Lambda MicroVM** boots from a pre-built snapshot (seconds, not minutes), registers with GitHub as a JIT self-hosted runner, executes the single workflow job, and calls `TerminateMicrovm` on itself when the job process exits.

## Project layout

```
cloudformation/
  01-foundation.yaml     Phase A: S3 code bucket + MicroVM build role (always deployable)
  02-orchestrator.yaml   Phase B: SQS, MicroVM execution role, both Lambdas, API Gateway
lambda/
  orchestrator/          Webhook receiver (index.js, filter.js)
  worker/                JIT token mint + RunMicrovm (index.js, github.js, microvms.js)
microvm/
  Dockerfile.base        Plain runner image (no Docker)
  Dockerfile.docker      Docker-in-Docker runner image
  app.js                 Lifecycle hook server baked into both images (port 9000)
  entrypoint.sh          Passes the JIT config to the GitHub Actions runner's run.sh
scripts/
  00-create-ssm-params.sh      Create the two required SSM SecureString parameters
  01-deploy-foundation.sh      Deploy 01-foundation.yaml
  02-package-lambdas.sh        Zip + upload both Lambda functions
  03-build-microvm-images.sh   Build the MicroVM image(s) via the AWS CLI (not CloudFormation)
  04-deploy-orchestrator.sh    Deploy 02-orchestrator.yaml
```

## Why the MicroVM image build isn't CloudFormation

There is **no CloudFormation resource type for MicroVM images or network connectors** — confirmed against AWS's own docs and the CDK reference repo, which notes the same thing: a `CreateMicrovmImage` build takes minutes and exceeds what a CloudFormation custom-resource handler can wait for. `scripts/03-build-microvm-images.sh` drives the build directly with `aws lambda-microvms create-microvm-image` / `update-microvm-image` and polls until the image reaches `CREATED`/`UPDATED`. Everything else — S3, IAM, SQS, both Lambdas, API Gateway — is ordinary CloudFormation.

## Prerequisites

- AWS CLI v2, configured with credentials for the target account/region.
- Confirm **Lambda MicroVMs is available in your target region**: `aws lambda-microvms list-managed-microvm-images`. This is a new service; it is not in every region yet.
- `jq`, `zip`, `npm`/Node.js 22+ locally (only used to package the worker Lambda's `node_modules`).
- A GitHub App (see below) — GitHub does not let a plain Personal Access Token mint JIT runner tokens.

## Deploy walkthrough

```bash
cd scripts

# 0. Create the GitHub App first (see "Create a GitHub App" below), then:
GITHUB_APP_CLIENT_ID=Iv1.xxxxxxxx \
GITHUB_APP_INSTALLATION_ID=12345678 \
PRIVATE_KEY_PATH=/path/to/app-private-key.pem \
./00-create-ssm-params.sh

# 1. Foundation stack (S3 bucket + MicroVM build role)
./01-deploy-foundation.sh

# 2. Package + upload both Lambda functions
./02-package-lambdas.sh

# 3. Build the MicroVM runner image(s) - takes several minutes each
./03-build-microvm-images.sh both

# 4. Deploy the orchestrator (queues, execution role, Lambdas, API Gateway)
RUNNER_SCOPE=organization RUNNER_GROUP_ID=1 ./04-deploy-orchestrator.sh
```

Each script is idempotent and safe to re-run. State (bucket name, image ARNs, webhook URL, etc.) is written to `scripts/.deploy-state.env` and picked up automatically by the next script.

To rebuild an image after changing `microvm/app.js`, an `entrypoint.sh`, or a Dockerfile: re-run `./03-build-microvm-images.sh <flavor>` — it detects the existing image by name and calls `update-microvm-image`, then re-run `./04-deploy-orchestrator.sh` (the image ARN itself doesn't change on an update, so this step is a no-op unless you also changed other parameters).

## Create a GitHub App

A GitHub App is required — it's the only way to mint short-lived JIT runner registration tokens without a human's personal token. Create one at **Settings → Developer settings → GitHub Apps → New GitHub App** (org-owned apps: **your org → Settings → Developer settings**).

Set `RunnerScope` to match how you installed the app:

### `RunnerScope=organization` (default)

- Install the App on the whole organization (or the specific repos you want it to cover — the permission below still applies org-wide for JIT config).
- **Organization permissions → Self-hosted runners: Read and write**.
- Webhook can be configured at the org level (**Org Settings → Webhooks**) or per-repo — either works, since the orchestrator reads `organization.login` straight from the payload.
- Needs a runner group ID (`RunnerGroupId`, default `1` = the default group). Find yours under **Org Settings → Actions → Runner groups**.
- Calls `POST /orgs/{org}/actions/runners/generate-jitconfig`.

### `RunnerScope=repository`

- Install the App on just the target repository/repositories.
- **Repository permissions → Administration: Read and write**.
- Webhook is configured on that repository (**Repo Settings → Webhooks**).
- **`RunnerGroupId` is still required** — confirmed against the live GitHub API: omitting it returns `422 missing required key: runner_group_id`, even though repositories (including personal-account ones with no organization at all) have no runner-group UI to look this up in. Leave it at the default `1`, which is the implicit default group every repo has.
- Calls `POST /repos/{owner}/{repo}/actions/runners/generate-jitconfig`.

Either way, after installing the App, collect:

- **App client ID** (`Iv1...`) — App settings page.
- **Installation ID** — the numeric ID in the URL after installing the app (`.../settings/installations/<id>`), or `gh api /app/installations`.
- **Private key** — generate one on the App settings page and download the `.pem`.

Feed all three into `scripts/00-create-ssm-params.sh` as shown above.

## Configure GitHub

1. Repository or organization → **Settings → Webhooks → Add webhook**.
2. **Payload URL**: the `WebhookUrl` output from `04-deploy-orchestrator.sh` (also in `scripts/.deploy-state.env`).
3. **Content type**: `application/json`.
4. **Secret**: the value `00-create-ssm-params.sh` printed.
5. **Which events**: at minimum "Workflow jobs".

## Trigger a runner

In a workflow file:

```yaml
jobs:
  build:
    runs-on: [self-hosted, lambda-microvms]        # plain runner image
    # runs-on: [self-hosted, lambda-microvms, docker]  # Docker-in-Docker image
    steps:
      - uses: actions/checkout@v4
      - run: echo hello from a MicroVM
```

`lambda-microvms` (configurable via `RequiredRunnerLabel`) is the label that tells the orchestrator to provision a runner at all; adding `docker` (configurable via `DockerRunnerLabel`) additionally routes the job to the Docker-in-Docker image instead of the plain one.

## Configuration reference

All of these are CloudFormation parameters on `02-orchestrator.yaml` (see the template for full descriptions); the deploy script exposes the common ones as environment variables.

| Parameter | Default | Notes |
|---|---|---|
| `RunnerScope` | `organization` | `organization` \| `repository` |
| `RunnerGroupId` | `1` | Required by GitHub's API for both scopes; leave at `1` for repository scope |
| `RequiredRunnerLabel` | `lambda-microvms` | Must be present for the orchestrator to act at all |
| `DockerRunnerLabel` | `docker` | Routes to the Docker-in-Docker image |
| `MicrovmMaxIdleSeconds` | `1800` | `idlePolicy.maxIdleDurationSeconds` — moot here since the runner self-terminates on job exit, kept as a safety net |
| `MicrovmSuspendedSeconds` | `10` | `idlePolicy.suspendedDurationSeconds` |
| `MicrovmMaxDurationSeconds` | `3600` | Hard ceiling before the platform force-terminates the MicroVM (max `28800` = 8h) |
| `WebhookSecretParamName` | `/github-runner-orchestrator/webhook-secret` | SSM SecureString, created by `00-create-ssm-params.sh` |
| `AppCredentialsParamName` | `/github-runner-orchestrator/app-credentials` | SSM SecureString, created by `00-create-ssm-params.sh` |

## Cost

Per the reference author's numbers: MicroVMs are billed at roughly **$0.0044/minute** for a 2 vCPU / 4 GB instance while running, plus roughly **$1.50/month** per image in snapshot storage. There's no idle compute cost — a runner exists only for the duration of one job. Add the usual (small) SQS/Lambda/API Gateway costs, which are negligible at CI-job volumes.

## Security notes

- The webhook secret, GitHub App private key, installation token, and JIT `encoded_jit_config` are never logged — see the comments in `lambda/orchestrator/index.js`, `lambda/worker/index.js`, and `microvm/app.js`. Error paths that touch the credential-bearing run-hook payload log the error *type* only, never the message, since a JSON/base64 parse error can echo fragments of the offending input.
- `MicrovmBuildRole` and `MicrovmExecutionRole` trust policies are scoped with `aws:SourceAccount` + `aws:SourceArn` conditions (confused-deputy protection), per AWS's documented guidance — the CDK reference left this as a bare `lambda.amazonaws.com` principal with a `// TODO VERIFY AT DEPLOY` comment.
- The runner MicroVM is launched with `NO_INGRESS` (no inbound connectivity at all) and `INTERNET_EGRESS` (unrestricted outbound, matching GitHub-hosted runner behavior). For network-restricted environments, swap `MICROVM_EGRESS_NETWORK_CONNECTORS` in `02-orchestrator.yaml` for a custom VPC egress connector (`aws lambda-core create-network-connector`) and update `WorkerRole`'s `PassNetworkConnectors` statement to include its ARN.

## Differences from the reference implementation

Cross-checking the CDK reference repo against AWS's own docs, and against what actually happens when deployed, surfaced a few IAM points worth calling out:

1. **`lambda:TerminateMicrovm` needs to be granted against BOTH `microvm-image:*` and `microvm:*` ARNs, depending on who's calling.** AWS's documented "operator policy" example (in the `aws-lambda-microvms` skill's `iam-and-security.md`) scopes `TerminateMicrovm` to `arn:...:microvm:*` — a running instance, not the image it was built from — which reads as more correct than the reference repo's choice of scoping it to the two image ARNs instead. In practice, confirmed against a live deployment, that documented example is for an *external* caller (like this project's Worker Lambda calling `RunMicrovm`) — but when a MicroVM terminates *itself* from inside the guest via its IMDSv2-vended session, the platform authorizes that specific call against the **image** ARN instead, and denies it against `microvm:*`. So the reference repo's original scoping was actually right for the self-terminate path; this project grants both shapes on `MicrovmExecutionRole` to cover both call sites correctly.
2. **Trust policies use an `aws:SourceAccount` condition.** The reference repo's build and execution role trust policies were a bare `Principal: lambda.amazonaws.com` with a code comment flagging it as unverified. An earlier version of this project also added an `aws:SourceArn` condition scoped to `microvm-image:*` per AWS's docs, on both roles — but that turned out to silently break the execution role's own IMDSv2 credential vending in practice (the same "documented example doesn't match observed behavior" pattern as point 1), so it's been dropped, leaving just `aws:SourceAccount` for confused-deputy protection.

The lesson from both of these: for this particular service, AWS's own published IAM examples don't reliably match what's enforced at runtime — verify against a real deployment's CloudWatch logs rather than trusting the docs alone if something doesn't behave as expected.

Everything else — the webhook HMAC verification, `workflow_job` filtering, JIT token minting via a GitHub App JWT → installation token → `generate-jitconfig`, the gzip-compressed run-hook payload, and the `/ready` `/run` `/terminate` lifecycle hooks in `microvm/app.js` — follows the reference implementation's design, translated from CDK/TypeScript into plain CloudFormation YAML and Node.js.

One thing intentionally *not* carried over: the reference `microvm/app.js` had a block that pre-pulled a specific SAM Lambda-bundling Docker image into the snapshot, tuned to that author's own CI workload. It's been removed here as irrelevant to a general-purpose runner image; the Docker daemon and DNS forwarder warm-up (which benefits every job that uses Docker) is kept.

## Cleanup

```bash
cd scripts
aws cloudformation delete-stack --stack-name "${PROJECT_NAME:-github-runner-orchestrator}-orchestrator"
aws cloudformation wait stack-delete-complete --stack-name "${PROJECT_NAME:-github-runner-orchestrator}-orchestrator"

# Delete the MicroVM images (CloudFormation doesn't own these)
aws lambda-microvms delete-microvm-image --image-identifier "$MICROVM_IMAGE_ARN_DOCKER"
aws lambda-microvms delete-microvm-image --image-identifier "$MICROVM_IMAGE_ARN_NO_DOCKER"

# 01-foundation.yaml's S3 bucket is DeletionPolicy: Retain - empty then delete it manually if you want it gone
aws s3 rm "s3://$CODE_BUCKET_NAME" --recursive
aws cloudformation delete-stack --stack-name "${PROJECT_NAME:-github-runner-orchestrator}-foundation"
```

## References

- [I replaced my GitHub runners with Lambda MicroVMs (and maybe you should too)](https://lucvandonkersgoed.com/2026/07/01/i-replaced-my-github-runners-with-lambda-microvms-and-maybe-you-should-too/)
- [donkersgoed/github-runner-ochestrator](https://github.com/donkersgoed/github-runner-ochestrator) — the CDK reference implementation this project ports
- [AWS Lambda MicroVMs — core concepts](https://docs.aws.amazon.com/lambda/latest/dg/microvms-how-it-works.html)
- [AWS Lambda MicroVMs — IAM and security](https://github.com/aws/agent-toolkit-for-aws/blob/main/skills/specialized-skills/serverless-skills/aws-lambda-microvms/references/iam-and-security.md)
- [AWS Lambda MicroVMs — networking](https://github.com/aws/agent-toolkit-for-aws/blob/main/skills/specialized-skills/serverless-skills/aws-lambda-microvms/references/networking.md)
- [GitHub REST API — self-hosted runners (JIT config)](https://docs.github.com/en/rest/actions/self-hosted-runners)
