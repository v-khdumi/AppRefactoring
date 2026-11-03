# Azure deployment

The Bicep template provisions the production runtime: Azure Container Apps, PostgreSQL Flexible Server, Service Bus with duplicate detection and dead-lettering, Key Vault, managed identity, Log Analytics, and Application Insights.

Before deployment:

1. Build and push immutable web, worker, and outbox images to Azure Container Registry. Pass `NEXT_PUBLIC_AZURE_TENANT_ID`, `NEXT_PUBLIC_AZURE_CLIENT_ID`, and `NEXT_PUBLIC_AZURE_API_SCOPE` as web image build arguments.
2. Create the Microsoft Entra API application and roles: `Modernization.Reader`, `Modernization.Admin`, and `Modernization.Approver`.
3. Create and install a GitHub App with repository metadata, contents, and pull-request permissions.
4. Store GitHub App credentials and webhook secret as Container App secrets or Key Vault references.
5. Deploy the template with organization-approved networking parameters; use private endpoints for regulated environments.
6. Run `npm run db:migrate` as a one-off deployment job before directing traffic to the new revision.

The worker and outbox images run concurrency-safe migrations before starting
their respective services. The outbox publishes only commit-bound, human-approved
changes and creates a draft pull request.

`main.bicep` also provisions `verification.bicep`, grants the runtime identity
job-scoped read/start permissions, and supplies the verification job ID and web
callback origin to the web and worker containers. The verifier has no managed
identity. Windows/.NET Framework verification still requires the separate
Container Instances permissions described in the operations runbook.

The user-assigned identity client ID is injected separately from the Entra API
application ID. Liveness uses `/api/health/live`; readiness uses `/api/health`.
The release workflow updates the migration job to the deployed worker image and
waits for that exact execution to succeed before deploying outbox and web.

Production policy must deny direct main-branch pushes and require all quality checks plus an independent approver.