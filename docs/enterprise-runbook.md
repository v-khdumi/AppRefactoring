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

## Release gates

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

Set `AZURE_LOCATION` and `AZURE_RESOURCE_GROUP` as environment variables. Protect `main`, require the Quality gates, CodeQL, and Container security checks, require review, and disallow force pushes.

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
az containerapp job start --name (azd env get-value MIGRATION_JOB_NAME) --resource-group (azd env get-value AZURE_RESOURCE_GROUP)
azd deploy --all --no-prompt
```

After deployment, validate shallow and authenticated deep health. Never log the health token.

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
