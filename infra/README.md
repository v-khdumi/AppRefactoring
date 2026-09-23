# Azure deployment

The Bicep template provisions the production runtime: Azure Container Apps, PostgreSQL Flexible Server, Service Bus with duplicate detection and dead-lettering, Key Vault, managed identity, Log Analytics, and Application Insights.

Before deployment:

1. Build and push immutable web and worker images to Azure Container Registry. Pass `NEXT_PUBLIC_AZURE_TENANT_ID`, `NEXT_PUBLIC_AZURE_CLIENT_ID`, and `NEXT_PUBLIC_AZURE_API_SCOPE` as web image build arguments.
2. Create the Microsoft Entra API application and roles: `Modernization.Reader`, `Modernization.Admin`, and `Modernization.Approver`.
3. Create and install a GitHub App with repository metadata, contents, and pull-request permissions.
4. Store GitHub App credentials and webhook secret as Container App secrets or Key Vault references.
5. Deploy the template with organization-approved networking parameters; use private endpoints for regulated environments.
6. Run `npm run db:migrate` as a one-off deployment job before directing traffic to the new revision.

The worker image runs `worker/index.ts` by default. The outbox Container App overrides the command with `worker/outbox.ts`; it publishes only commit-bound, human-approved changes and creates a draft pull request.

Production policy must deny direct main-branch pushes and require all quality checks plus an independent approver.