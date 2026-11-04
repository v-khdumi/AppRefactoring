# Enterprise operations runbook

## Qualification Status

The September 2026 deployment in `rg-demo` is a controlled engineering pilot,
not a certified production service for arbitrary legacy applications. The gates
below are required, not a list of gates that have already passed.

Implemented controls include server-side Python/npm readiness checks,
contract-first coordinated generation, original-test preservation, isolated npm
lock preparation, source/digest-bound verification and explicit publication
approval. Run locks and attempt tokens prevent duplicate or stale workers from
overwriting terminal state; refinements invalidate prior evidence immediately.

Recorded acceptance on 2026-09-23 includes PostgreSQL transactions for dependency
artifacts and durable refinements, real Linux timeout/user/file isolation probes,
and real Foundry generation followed by baseline/candidate verification of a
synthetic backend library. A second full-app fixture generated backend and client
changes with Foundry, then passed its unchanged original HTTP contract test and
14 candidate tests in Azure, including actual authenticated client/server calls,
validation errors and response semantics. Jobs `modernize-isolated-verifier-gtivqiv`
and `modernize-isolated-verifier-nmz0egi` produced passing command reports.
These tests do not certify every application, a
complete dependency graph, live external integrations or hostile-code isolation.

Before admitting untrusted external tenants, complete dedicated verifier
network/egress isolation and adversarial testing. Before a production release,
obtain current CodeQL/container-scan evidence, pin all verifier images/tools,
exercise restore and disaster recovery against approved RTO/RPO, resolve queue
incidents, perform load/soak testing, and complete the independent approval and
authenticated repository canary gates. Do not describe a passing build or a
draft PR as completion of these requirements.

The initial local acceptance did not provide CodeQL, Trivy or Docker executables.
GitHub Actions subsequently supplied CodeQL and application-container scan evidence
for the application release below. Dependency audit is not a substitute for those
checks or for adversarial sandbox testing.
No production qualification or independent environment approval is implied by a
manual update to the existing pilot.

The 2026-09-23 pilot release passed all 106 platform tests, the production build,
and targeted worker/verifier lint with zero warnings. Deployed and ready revisions
are `modernize-demo-7pd4tn-web--azd-1790153235`,
`modernize-demo-7pd4tn-worker--azd-1790153291`, and
`modernize-demo-7pd4tn-outbox--azd-1790153414`. Public and protected deep health
returned HTTP 200 with two fresh workers; the transformation API returned 401
without authentication. Five historical dead-letter messages remain unresolved,
so the zero-dead-letter production gate has not passed despite healthy endpoints.
The authenticated dashboard and empty-repository wizard were checked after a page
reload. No new repository canary or publication approval was performed for this
release, and `gpt-6-astra` remains configured.

### Application Update, 2026-09-23

The application update is scoped to refactoring functionality and the existing
Azure deployment. Backup/DR expansion and a new canary repository were excluded
by the operator; they are not prerequisites for this pilot update or passed gates.

Commit `84d3a68` passed Quality gates, CodeQL and all three Container security
jobs in GitHub Actions. Trivy and its action are pinned; individual scans no longer
cancel one another and retain separate SARIF reports. Application base images use
immutable digests, runtime npm/Yarn tooling is removed, workers omit development
dependencies, and `tsx` remains an explicit production dependency. The complete
dependency audit returned zero vulnerabilities after updating `js-yaml`.

The final local suite passed 108 tests and the production build. Verifier
infrastructure and dispatch now use the same immutable image. A fresh Foundry
full-app fixture passed all eight baseline/candidate commands in Azure job
`modernize-isolated-verifier-3u3r7u8`: one original baseline HTTP test and 61
candidate tests passed without skips. This is fixture acceptance, not a claim
that every legacy application or external integration has been verified.

The five inspected dead-letter messages are September 5 failed attempts for the
subsequently published wealth run. They were not replayed or silently discarded.

### Application Update, 2026-09-24

Refactoring now covers npm, Python, .NET (SDK-style and .NET Framework), Maven,
Gradle, Go and PHP/Composer. Real Foundry generations were verified in Azure for
each compiled ecosystem: .NET `modernize-isolated-verifier-b8tcy16`, Gradle
`wi8fe10`, PHP `50j1610`, Go `9pj4euq` and Maven `w1bup6d`. Candidates were clean;
baseline-only high findings are diagnostics.

.NET Framework repositories run in a per-job Windows Container Instances group,
verified by `mz-winverify-start-1790234580` (legacy `net48` baseline with
`packages.config`, `net10.0` candidate, result `passed`). That group needs the
custom role "ModernizeAI Windows verification container operator"
(`Microsoft.ContainerInstance/containerGroups` read/write/delete on the resource
group) for the web and worker identities, plus the registered
`Microsoft.ContainerInstance` provider.

The Windows verifier accepts .NET-only repositories. Mixed .NET Framework and
npm/Python repositories are refused with an explanation.

The five obsolete dead-letter messages for the published wealth run were
completed with recorded evidence, and deep health reports zero dead letters. No
user repository has been modernized with this release yet. Human PR approval
remains mandatory.

On 2026-09-24 the operator excluded dedicated verifier egress isolation and
adversarial testing, backup/DR exercises, load/soak testing, independent approval
and the dedicated canary repository from this pilot. They remain open for any
external-tenant or certified production release.

## Implementation verification, 2026-11-04

An identity-free ephemeral job, `modernize-canary-40f315b8-214s4xj`, executed the
current npm verification runner in the existing pilot on 2026-11-04. Actual Node
TAP tests passed on baseline and candidate. Failed tests, zero-test scripts and
skipped tests were rejected. Separate UID, sanitized environment and timeout
assertions passed. Only the dedicated canary job was created and deleted; the
existing application revisions and verifier definition were not changed.

The dedicated PostgreSQL canary execution
`modernize-approval-40f315b8-8mcaahd` applied all seven migrations to an ephemeral
PostgreSQL 15.19 instance, with no connection to the pilot database. It verified
self/contributor approval rejection, tenant isolation, stale digest and zero-test
evidence rejection, append-only auditing, and concurrent independent approvals
producing exactly one approval and one outbox event. Its verifier reports were
synthetic fixtures for SQL transaction tests; this is not application behavior
verification or an Entra sign-in canary. The owned job and its database were
deleted after acceptance.

This is targeted verifier evidence, not an authenticated source-provider
publication canary, a Windows/new-ecosystem qualification, a container scan or
production certification. Newly added provider connections and specialized
strategy harnesses require their own live acceptance.

The candidate Semgrep canary `modernize-security-40f315b8-nace6t7` passed clean
source and rejected actual dynamic-evaluation, credential and ignore-file
bypass fixtures using the pinned local scanner. Runtime canaries separately
qualified pnpm, both Yarn generations, Poetry, uv, Pipenv, Rust and Ruby;
the exact fixtures and negative cases are recorded in the verification runner
documentation.

Mixed Windows qualification did **not** pass. Dedicated ACI group
`modernize-win-canary-40f315b8` pulled the pinned Windows image, but Azure
containerd failed before supervisor startup with a closed bridge/network
connection. The owned group was deleted. An alternative West Europe group was
rejected by Azure `RequestDisallowedByAzure` / `locationineligible`. No runtime
or audit gate was waived. Mixed Windows readiness remains blocked; its
implemented helper has local regression coverage only.

Authenticated source-provider canaries are explicitly deferred by the operator
until dedicated repositories and service credentials are configured. Native
C/C++ and COBOL compile/test canaries ran, but mandatory dependency audits found
unrated or incomplete external evidence and blocked the candidates. These are
open qualification items, not claims that arbitrary repositories can publish.

### GitHub-only pilot release scope

The operator subsequently restricted repository support to GitHub.com and
authorized a pilot update in the existing `rg-demo`, not a new production
environment. Other-provider adapters and service-token configuration have been
removed from the server, UI and infrastructure. The authorized repository canary
is `v-khdumi/transcript`, replacing the earlier `myNews` selection. Its source
branch must remain unchanged, and independent approval cannot be substituted
with a synthetic actor or a database update.

The application images now share a refreshed immutable Node/Alpine base and
apply available Alpine security updates in each stage. The dedicated Trivy
execution `modernize-gate40f315b8-scan-d9q3frp` completed scans of all three
candidate image digests successfully, including all vulnerability severities
and secret scanning, retaining the existing `ignore-unfixed` policy. A final
release must still be tied to the exact built/scanned digest. No canary or
deployment success is implied until its corresponding evidence is recorded.

The authenticated transcript analysis reached Foundry but failed with
`AuthenticationTypeDisabled`: the existing Foundry account has local key
authentication disabled. The operator approved Managed Identity, leaving that
policy intact. Account-scoped Cognitive Services User assignments were granted
only to the existing pilot web and worker identities. An inference request
executed inside the actual web identity returned HTTP 200 without a key.

The App webhook configuration API returned 404 and no webhook/secret change was
made. The operator explicitly approved a pilot without webhook ingestion:
`GITHUB_WEBHOOK_ENABLED=false` makes the receiver reject all deliveries with
HTTP 503 and exposes the disabled status through health/settings. Enabled
deployments still require the matching webhook secret; the flag does not waive
GitHub App authentication, source-bound verification or independent approval.
Re-enable ingestion only after the App owner configures and validates it.

The operator authorized a controlled `rg-demo` rollout after passing CI and
container scans because the old application cannot perform Managed Identity
inference. The transcript canary must run immediately afterward; keep prior
revision/image references for rollback and do not synthesize approval actors.

### Pilot rollout evidence, 2026-11-04

Code revision `2c4e8279d34d51c8366dc089fc5815a55d744053` is deployed to all three
existing pilot apps. Their latest ready revisions are:

- `modernize-demo-7pd4tn-web--r2c4e827`
- `modernize-demo-7pd4tn-worker--r2c4e827`
- `modernize-demo-7pd4tn-outbox--r2c4e827`

GitHub Quality gates `41913997092`, CodeQL `41913997136` and Container security
`41913997127` succeeded for that exact code revision. All 175 platform tests
passed. ACR builds `ca4k`, `ca4n` and `ca4m` produced the deployed immutable
web/worker/outbox digests; dedicated scan execution
`modernize-gate40f315b8-scan-kjxo06t` passed all three images with the existing
unfixed-finding policy, all severity levels and secret scanning.

Before rollout, hashes proved the running migration script and all seven SQL
files were byte-identical to the release. The concurrency-safe migrator then
completed successfully. Prior ready image/revision references were retained.
The deployment handled asynchronous Azure PATCH responses without assuming an
empty HTTP response meant failure; actual latest-ready revisions were checked.

After rollout, liveness, shallow readiness and authenticated deep readiness
returned HTTP 200. Deep readiness confirmed both expected healthy fresh workers,
zero active/dead-letter/scheduled queue messages and a reachable verifier.
Webhook ingestion is explicitly disabled, visible in health/settings, and
rejects deliveries with HTTP 503 as approved for this pilot. The temporary
scanner job and its short-lived registry credentials were removed.

The authenticated transcript canary run is
`240a5a8a-fe71-42a9-befe-9b1ed0286765`, source SHA
`2f91b4f0898b6c425bd28a6c528679e161dbbe3e`, target
`modernize/canary-transcript-20261104-2c4e827`. Live analysis completed through
Managed Identity, and generation/verification was started on the deployed
release. At this record's creation, the original source branch was unchanged and
no target branch or PR had been published. This is not a claim that the canary's
verification or independent publication approval has passed; record its terminal
outcome separately.

The canary subsequently reached `awaiting-approval`. Verification job
`1831299c-237a-491c-a7cb-cd847014224c` passed against changeset digest
`7cc0266085eb45852616b1fa092c7d8bd8f3979cb7ed7deba3179584d6e5c880`:
25 unittest tests on each variant, plus 25 desktop integration/acceptance tests
on each variant, all without failures or skips. Candidate dependency audit and
the mandatory local Semgrep/credential scan passed.

Earlier attempts were correctly blocked: the generated candidate retained the
original vulnerable `python-dotenv==1.0.1`, and the acceptance harness used an
unavailable `python` command, then omitted the virtual display required for Tk.
Normal, real-user audited Security/Testing Agent refinements updated the
candidate dependency to `1.2.2`, preserved strict original/candidate pin
expectations and wired the actual GUI suite through Xvfb. No audit or test gate
was skipped. The original baseline vulnerability remains a diagnostic, not a
claim that the source dependencies are clean.

The source `main` SHA remained
`2f91b4f0898b6c425bd28a6c528679e161dbbe3e`, with no target branch or PR created.
The initiating administrator's approval access is correctly denied. Publication
requires a real independent reviewer; no approval identity was invented and no
source writes or automatic merge were performed. Passing mocked Speech-service
contracts and headless GUI tests do not establish live microphone/Azure Speech
integration. All pilot revisions remain ready, and only the permanent isolated
verifier job remains after temporary scanner cleanup.

### GitHub integration validation

The modernization expansion was integrated with the previously merged production
hardening changes, retaining local font assets, dependency-independent liveness,
bounded readiness queries, explicit runtime identity selection, connection-string
authentication, database idle-client error handling and migration success
waiting. The release workflow reuses the tested migration helper and deploys
only scanned image digests. The web image explicitly packages every verifier
helper served through scoped job capabilities.

The combined revision passed all 181 tests without skips, full lint, TypeScript,
the production build, Bicep compilation and a zero-vulnerability production
dependency audit. Migration helper tests execute on both Linux and Windows/Git
Bash rather than skipping Windows coverage. This local integration evidence does
not assert that GitHub Actions CodeQL/container scans have completed, that a new
Azure release was deployed, or that the qualification blockers above are closed.

## Release gates

### Explicit single-operator pilot approval policy

The operator may choose a pilot-only Administrator self-approval exception.
It requires both `DEPLOYMENT_TIER=pilot` and
`PILOT_ALLOW_ADMIN_SELF_APPROVAL=true`; the default is production/false.
The source initiator and contributor restrictions remain unchanged for ordinary
Approvers and all production deployments. Missing initiator identity is never
waived. Enabling the exception for a production tier fails configuration checks,
and production IaC/workflow force the exception off.

For an eligible administrator, Execution shows a per-changeset acknowledgement.
The API independently requires this acknowledgement and still checks the exact
source SHA, current verified changeset digest, Testing Agent result and every
file's evidence under the run transaction lock. Edits invalidate the old evidence
and acknowledgement. The immutable approval audit records the actual actor,
digest, deployment tier and `approvalMode=pilot-admin-self`; no separate reviewer
identity is invented. Enabling the policy alone never approves or publishes a
run; the operator must review and explicitly submit the approval.

The operator chose and enabled this exception for the existing pilot on
2026-11-05. Web/API source `ac8dc8257a90a572ed4902e3b9610fa77b7437cc` is
deployed as `modernize-demo-7pd4tn-web--rac8dc82`, immutable digest
`sha256:67b605c080bf4418ade0bc1bdb2e673c4c0867900b85689526448688dd07dd66`
from ACR build `ca4p`. Worker and outbox revisions were left unchanged.
All 177 platform tests, production build, TypeScript, lint and Bicep passed;
GitHub Quality `41925969319`, CodeQL `41925969504` and Container security
`41925969388` succeeded. The exact web digest also passed the dedicated
all-severity/secret scan `modernize-approve-scan-40f315b8-5w3xixo`.

The identity-free PostgreSQL canary
`modernize-selfapprove-40f315b8-6b9lmbw` verified seven migrations in an isolated
database, explicit acknowledgement, real-actor exception auditing, stale and
unverified changeset rejection, non-administrator rejection, production denial,
append-only audit and exactly one approval/outbox event under concurrent review.
Both temporary validation jobs were removed afterward.

The real transcript initiating administrator subsequently acknowledged and
approved the verified changeset through the application UI. Read-only inspection
confirmed `approvalMode=pilot-admin-self`, `deploymentTier=pilot`, the real audit
actor matching the initiator and the unchanged verified digest. No assistant API
approval or fabricated independent identity was used. Publication created
[v-khdumi/transcript#2](https://github.com/v-khdumi/transcript/pull/2), confirmed
open, draft and unmerged, from source
`2f91b4f0898b6c425bd28a6c528679e161dbbe3e` to generated head
`b2476a8bf517ed6268d9cc92cdb49c29b9ac4a51`. The source branch remained unchanged.
Deep readiness remained healthy with two fresh workers, a reachable verifier and
zero queue/dead-letter messages. This pilot exception does not qualify as
independent production approval.

A production release is permitted only when all of these gates pass:

1. Unit and safety tests, lint, TypeScript, Next.js production build, dependency audit, CodeQL, container scan, and Bicep compilation are green.
2. The GitHub `production` environment approval is granted by an independent approver.
3. Images use immutable tags or digests and originate from the approved Premium ACR.
4. Database backup status and restore-point availability are verified.
5. The migration job completes successfully before application traffic is evaluated.
6. `/api/health` returns `healthy` and authenticated `/api/health?deep=true` reports fresh workers and zero dead-letter messages.
7. A canary modernization against the approved test repository reaches `awaiting-approval` without source writes.
8. Publishing the canary creates only a new branch and draft pull request.

## Required GitHub configuration

Create a protected `production` environment with required reviewers and these secrets:

- `AZURE_CLIENT_ID`: federated deployment identity.
- `AZURE_TENANT_ID`: Microsoft Entra tenant.
- `AZURE_SUBSCRIPTION_ID`: production subscription.
- `HEALTH_CHECK_TOKEN`: random value of at least 32 characters matching Key Vault.

Set `AZURE_LOCATION`, `AZURE_RESOURCE_GROUP`, `ENTRA_TENANT_ID` and `ENTRA_CLIENT_ID`
as production environment variables. The Entra browser identity is distinct from
the OIDC deployment identity. Also set `SERVICE_WEB_NAME`, `SERVICE_WORKER_NAME`,
`SERVICE_OUTBOX_NAME`, `MIGRATION_JOB_NAME` and `AZURE_CONTAINER_REGISTRY_ENDPOINT`
from the approved infrastructure outputs; the workflow validates those explicit
resources without depending on local `azd` state. Protect `main`, require the Quality gates, CodeQL,
and Container security checks, require review, and disallow force pushes. The
resource group must already be provisioned; neither the federated deployment
identity nor the runtime user-assigned identity is the browser API application.

## Required Azure configuration

- Use a dedicated production subscription or management-group landing zone.
- Apply Azure Policy for allowed regions, required tags, diagnostic settings, TLS, private networking, and Defender for Cloud.
- Grant the deployment identity only resource-group-scoped permissions required by Bicep.
- Grant runtime identities data-plane roles; do not enable Service Bus local authentication.
- Keep PostgreSQL Zone Redundant with geo-redundant backups and at least 35 days retention.
- Confirm Key Vault purge protection, RBAC authorization, soft delete, and secret rotation ownership.
- Route alerts to a staffed operations group and test the action group quarterly.

## Deployment

Use the `Production deployment` GitHub workflow. Manual workstation deployment is break-glass only.

For a controlled manual release:

```powershell
azd auth login
azd provision --no-prompt
azd deploy worker --no-prompt
$group = azd env get-value AZURE_RESOURCE_GROUP
$worker = azd env get-value SERVICE_WORKER_NAME
$image = az containerapp show --name $worker --resource-group $group --query "properties.template.containers[0].image" --output tsv
bash scripts/deploy-migrations.sh $group (azd env get-value MIGRATION_JOB_NAME) $image
if ($LASTEXITCODE -ne 0) { throw "Database migration release gate failed." }
azd deploy outbox --no-prompt
azd deploy web --no-prompt
```

The migration gate updates the job image to the release worker image, starts a
specific execution, and fails on an unsuccessful, unexpected, or timed-out result.
Starting a job is not evidence that migrations completed.

After deployment, validate shallow and authenticated deep health. Never log the
health token. Deep health returns HTTP 503 for missing, stale, starting, stopping,
or degraded required workers, queue failures, and nonzero dead letters.
Use `/api/health/live` only for restart probes: it deliberately ignores external
dependencies, while `/api/health` is the readiness gate.

## Rollback

1. Stop new run creation by restricting the Entra application role or ingress.
2. Keep workers running long enough to settle already claimed Service Bus messages unless data integrity is at risk.
3. Activate the last known-good Container Apps revision for web, worker, and outbox.
4. Do not roll back a database migration destructively. Deploy a forward-compatible corrective migration.
5. Verify worker heartbeats, queue depth, dead-letter count, and outbox state.
6. Re-run the canary transformation before restoring normal access.
7. Record the incident and revision IDs in the audit trail.

## Incident response

### Run stalled

- Check authenticated deep health for stale worker heartbeat and queue depth.
- Inspect structured logs using `runId` as correlation ID.
- Use Retry only after correcting the dependency failure; retries are rate-limited and audited.
- Cancel a run when generated output is no longer wanted. Cancellation is checked before persistence.

### Dead-letter messages

- Treat any dead-letter count as an operational incident.
- Inspect the dead-letter reason and correlated run before replay.
- Administrators inspect and selectively replay messages through `/api/operations/dead-letters`; every replay is audited.
- Correct the root cause, replay only the selected message, and retain evidence. Do not blindly resubmit messages.

### Pull request publication failure

- Confirm the GitHub App installation, permissions, target repository, and source commit SHA.
- Resolve branch-name conflicts or source drift.
- Retry the `publication-failed` run; the outbox uses locking and exponential backoff.

### Foundry degradation

- Review timeout/throttling events and retry counts.
- Pause new transformations if failure rates remain elevated.
- Repository recommendation may use evidence fallback, but code generation must not bypass quality gates.

## Backup and disaster recovery

- Test PostgreSQL point-in-time restoration in an isolated resource group quarterly.
- Export Key Vault, Entra, GitHub App, DNS, and Azure Policy configuration through approved infrastructure processes.
- Validate a full regional recovery at least annually.
- Define and approve business RTO/RPO; the template provides HA and geo-backup but does not establish organizational targets.

## Security operations

- Rotate GitHub App private keys, webhook secret, Foundry credentials, database credentials, and health token on the organizational schedule and after suspected exposure.
- Review Entra app-role assignments quarterly.
- Review GitHub App installations and repository scope monthly.
- Triage CodeQL, dependency, secret-scanning, Defender, and Trivy findings before release.
- Preserve audit and operational logs according to the organization's retention policy.
