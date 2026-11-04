# Azure deployment

The Bicep template provisions the production runtime: Azure Container Apps, PostgreSQL Flexible Server, Service Bus with duplicate detection and dead-lettering, Key Vault, managed identity, Log Analytics, and Application Insights.

It also provisions a separate Container Apps environment and identity-free
verification job, injects its ID and callback origin into web/worker, and grants
the runtime identity scoped job-start and Windows verification container-group
permissions. Separate environment placement alone is not controlled egress or
hostile-code qualification; those release gates still apply.

Before deployment:

1. Build and push immutable web, worker, and outbox images to Azure Container Registry. Pass `NEXT_PUBLIC_AZURE_TENANT_ID`, `NEXT_PUBLIC_AZURE_CLIENT_ID`, and `NEXT_PUBLIC_AZURE_API_SCOPE` as web image build arguments.
2. Create the Microsoft Entra API application and roles: `Modernization.Reader`, `Modernization.Admin`, and `Modernization.Approver`.
3. Create and install a GitHub App with repository metadata, contents, and pull-request permissions.
4. Store GitHub App credentials and webhook secret as Container App secrets or Key Vault references.
   GitHub.com is the only source provider. Never place App credentials in browser
   build arguments or run options.
5. Deploy the template with organization-approved networking parameters; use private endpoints for regulated environments.
6. Run `npm run db:migrate` as a one-off deployment job before directing traffic to the new revision.

The worker and outbox images run concurrency-safe migrations before starting
their respective services. The outbox publishes only commit-bound, human-approved
changes and creates a draft pull request.

The user-assigned identity client ID is injected separately from the Entra API
application ID. Liveness uses `/api/health/live`; readiness uses `/api/health`.
Set `foundryAuthMode=managed-identity` for Foundry accounts with local
authentication disabled, and grant the runtime web/worker identity the required
inference role on that exact account. Do not re-enable key authentication to
bypass the account's policy. `api-key` remains an explicit compatibility mode.
The release workflow updates the migration job to the scanned release worker
image and waits for that exact execution to succeed before deploying the worker,
outbox and web. Windows execution remains subject to the qualification gates
documented in the runbook even though its scoped permissions are provisioned.

Production policy must deny direct main-branch pushes and require all quality checks plus an independent approver.

The production template and production release workflow explicitly set
`DEPLOYMENT_TIER=production` and `PILOT_ALLOW_ADMIN_SELF_APPROVAL=false`.
The server refuses production self-approval even if a client supplies an
acknowledgement. A separately operated pilot may explicitly set
`DEPLOYMENT_TIER=pilot` together with `PILOT_ALLOW_ADMIN_SELF_APPROVAL=true` on
the web application only. This permits administrators, not ordinary approvers,
to acknowledge and approve their own currently verified changeset. Audit records
retain the real actor, source/digest, deployment tier and `pilot-admin-self` mode.
It does not bypass tests, scans, source consistency or the draft-PR-only policy.

The production workflow requires separate `ENTRA_TENANT_ID` and `ENTRA_CLIENT_ID`
environment variables for browser authentication; deployment OIDC credentials are
not the browser application's identity. Set `SERVICE_WEB_NAME`,
`SERVICE_WORKER_NAME`, `SERVICE_OUTBOX_NAME`, `MIGRATION_JOB_NAME` and
`AZURE_CONTAINER_REGISTRY_ENDPOINT` from the provisioned Bicep outputs as
protected production environment variables. CI validates these exact resources
and does not rely on workstation-local `.azure` state. It builds each release
image once, scans those images, pushes them and deploys their
digests. The migration job is updated to that worker digest and must finish
successfully before the app revisions are updated. Configure the protected
production environment and validate this workflow in a release canary before
relying on it.