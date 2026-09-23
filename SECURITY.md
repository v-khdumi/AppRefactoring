# Security policy

## Reporting a vulnerability

Do not open a public issue for suspected vulnerabilities. Report them through the organization's private security channel and include affected version, reproduction steps, impact, and suggested mitigation. Do not include credentials, repository content, personal data, or production logs in the report.

## Supported releases

Only the currently deployed production revision and the immediately preceding rollback revision receive security fixes.

## Security boundaries

- Microsoft Entra ID authenticates users; application roles authorize reader, administrator, and approver actions.
- GitHub access uses short-lived GitHub App installation tokens scoped to selected repositories.
- Source writes are limited to a new branch and draft pull request after commit-bound approval.
- Runtime Azure access uses managed identity where supported.
- Secrets are stored in Key Vault and referenced by Container Apps.
- Model context excludes protected paths, binaries, generated output, secrets, and oversized files.
- Independent testing evidence and human approval are required before publication.

## Required response

Critical findings block release immediately. Rotate affected credentials, preserve audit evidence, disable compromised integrations, and follow the enterprise incident runbook in `docs/enterprise-runbook.md`.
