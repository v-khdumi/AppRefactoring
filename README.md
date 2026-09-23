# ModernizeAI

ModernizeAI is an engineering control center for analyzing and incrementally modernizing legacy applications. It connects to GitHub, maps the current architecture with a Microsoft Foundry model, proposes a target architecture, and runs a controlled transformation workflow that protects existing behavior.

## Product capabilities

- Public and private GitHub repositories with server-side, non-persisted credentials.
- Frontend, backend, or full-stack modernization scope.
- Target language and framework selection.
- Azure cloud-readiness and optional AI capabilities.
- Current-versus-target architecture visualization.
- Prioritized findings, recommendations, and phased migration roadmap.
- Observable execution pipeline with live stage progress.
- Exact file-level change manifest and side-by-side before/after diffs.
- Rationale and validation evidence for every proposed file change.
- Compilation, security, contract, regression, and behavior-parity gates.
- Human approval before pull-request creation.
- Immutable activity-log experience.
- Parallel specialist agents for architecture, frontend, backend, cloud, testing, and security.
- Per-agent ownership, status, progress, and conversational refinement.
- User-editable generated files with automatic Testing Agent revalidation.
- User-editable and versioned target architecture diagrams.
- AI-adjusted delivery estimates separating generation time from validation and human review.
- Explicit demo mode that never claims to have modified a real repository.

## Run locally

Requirements: Node.js 20 or newer and npm 10 or newer.

1. Copy `.env.example` to `.env.local`.
2. Run `npm install`.
3. Run `npm run dev`.
4. Open `http://127.0.0.1:3000`.

Demo behavior is opt-in. Set `DEMO_MODE=true` only in an isolated demonstration environment; missing production integrations fail closed.

## Microsoft Foundry

Configure these server-only environment variables:

| Variable | Purpose |
| --- | --- |
| `AZURE_AI_FOUNDRY_ENDPOINT` | Foundry model inference endpoint |
| `AZURE_AI_FOUNDRY_API_KEY` | Access key; use Key Vault or managed identity in production |
| `AZURE_AI_FOUNDRY_MODEL` | Model or deployment name |
| `AZURE_AI_FOUNDRY_API_VERSION` | Model inference API version |
| `DEMO_MODE` | Set to `false` to require live integrations |

The endpoint must support Azure AI Model Inference `chat/completions`. The API key has no `NEXT_PUBLIC_` prefix and is never included in the client bundle.

## Safe production workflow

1. **Discover** — read-only inventory, languages, dependencies, SBOM, and integration map.
2. **Baseline** — characterization tests and external behavior contracts.
3. **Plan** — target architecture, ADRs, risk register, and migration waves.
4. **Transform** — isolated branch and pull request for each vertical slice.
5. **Verify** — build, SAST, dependency scan, contracts, regression tests, and shadow traffic.
6. **Review** — exact diff, rationale, model actions, and quality evidence.
7. **Approve** — human approval before pull request, deployment, or cutover.
8. **Observe** — telemetry, behavior parity, rollback signals, and audit trail.

## Multi-agent execution model

The orchestrator dispatches architecture, frontend, backend, cloud, testing, and security specialists concurrently. Each agent owns an isolated set of paths. Outputs are merged only when identical paths do not conflict; conflicting output blocks the run. Users can send focused instructions to any agent, and every refinement is persisted in the conversation and audit trail.

The Testing Agent is independent from implementation agents and is restricted to test artifacts. Manual code edits clear prior validation evidence and automatically queue the Testing Agent. Approval remains blocked until the Testing Agent passes and every file has current evidence.

## Estimation model

Delivery estimates are adjusted for AI parallelism but do not treat generation speed as total delivery time. The displayed range accounts for repository size, modernization scope, technical findings, cloud/AI additions, parallel agent count, behavior-parity validation, and human approval. The UI separately displays estimated agent-generation hours and verification days, together with confidence and assumptions.

Real repository writes use the GitHub App, short-lived installation tokens, commit-bound approval, an isolated branch, and a draft pull request. Direct writes to the source branch are prohibited.

## API routes

- `GET /api/health` — service status and demo/live mode.
- `POST /api/repositories/inspect` — read-only repository inspection.
- `POST /api/analysis` — demo or live Microsoft Foundry architecture analysis.
- `GET|POST /api/transformations` — tenant-scoped durable transformation runs.
- `GET /api/transformations/:id` — run progress and exact persisted changes.
- `POST /api/transformations/:id/approve` — role-protected, commit-bound approval.
- `GET|POST /api/operations/dead-letters` — administrator-only inspection and audited selective replay.
- `POST /api/github/webhook` — signed GitHub App event ingestion.

## Production runtime implemented

- Microsoft Entra JWT validation and application-role authorization.
- PostgreSQL schema for runs, changes, approvals, append-only audit events, and a transactional outbox.
- Azure Service Bus dispatch with stable message identifiers.
- GitHub App JWT and short-lived installation-token support.
- Durable Foundry transformation worker with bounded repository context and path/content policy enforcement.
- Commit-SHA consistency checks before publishing generated Git trees.
- Transactional outbox publisher that creates isolated branches and draft pull requests only after approval.
- SHA-256 GitHub webhook signature verification.
- Production configuration fail-fast checks and dependency-aware readiness probes.
- Multi-stage, non-root, health-checked container image.
- Azure Bicep for Container Apps, PostgreSQL, Service Bus, Key Vault, managed identity, Application Insights, and autoscaling.
- Private PostgreSQL networking, zone-redundant HA, geo-redundant backup, Premium ACR, Key Vault references, queue alerts, and managed-identity KEDA scaling.
- Worker and outbox heartbeats, stale-run recovery, structured correlation logs, bounded dependency retries, cancel/retry controls, and deep operational health.
- Approval-gated OIDC production deployment, CodeQL, container vulnerability scanning, deterministic builds, and dependency auditing.
- Microsoft Entra browser sign-in with silent token acquisition and role-protected API calls.
- Content Security Policy and standard browser security headers.
- Zero known production dependency vulnerabilities at the latest local audit.

## Go-live sequence

1. Provision an Azure resource group from `infra/main.bicep`; never use `infra/demo` for production.
2. Create Microsoft Entra application roles and assign users or groups.
3. Create and install the GitHub App, then inject its credentials through Key Vault references.
4. Configure the Foundry endpoint/model and grant the managed identity access.
5. Run the provisioned migration job; worker startup also performs concurrency-safe migrations as a recovery guard.
6. Deploy an immutable image digest and run smoke, integration, and penetration tests.
7. Configure DNS, WAF, private endpoints where required, alerts, backup restoration tests, and on-call ownership.
8. Disable demo mode and verify `/api/health` reports live dependencies as healthy.

Follow [the enterprise operations runbook](docs/enterprise-runbook.md) for release gates, rollback, incidents, backup restoration, and credential rotation. Organizational RTO/RPO, penetration-test acceptance, and compliance sign-off remain governance decisions outside application code.

## Security requirements

- Never persist personal GitHub tokens or include them in telemetry.
- Use GitHub App installation tokens in production.
- Store secrets in Azure Key Vault and prefer managed identity.
- Add enterprise authentication, authorization, rate limiting, and durable audit storage before public exposure.
- Exclude binaries, generated output, credentials, and oversized files from model context.
- Require protected branches and signed approval evidence before merge.

## Project structure

- `src/components` — dashboard, wizard, architecture, progress, diff, validation, and audit views.
- `src/app/api` — server-side boundaries and Zod validation.
- `src/lib/github.ts` — read-only GitHub REST client.
- `src/lib/foundry.ts` — Microsoft Foundry model orchestration.
- `src/types` — shared domain contracts.

## Quality checks

Run `npm test`, `npm run lint`, `npm run build`, and `npm run security:audit` before every merge. CI also compiles Bicep, runs CodeQL, builds both containers, and blocks high or critical Trivy findings.
