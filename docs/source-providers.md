# Source connections

The analysis, generation, repair, verification snapshot and publication paths use
the same provider abstraction. Credentials stay on the server and are not saved
with a run or sent to the model. Repository snapshots remain bound to a 40-digit
Git commit, limited to 3000 files / 30 MB, with unsafe paths, symlinks, submodules
and tracked credential files rejected.

## Providers

| Provider | Repository URL | Authentication |
| --- | --- | --- |
| GitHub | `https://github.com/owner/repository` | Existing GitHub App installation |
| GitHub Enterprise | `https://approved-host/owner/repository` | Configured service credential; default API path `/api/v3` |
| GitLab | `https://gitlab.com/group/subgroup/repository` | Public read access or configured service token |
| Azure Repos | `https://dev.azure.com/organization/project/_git/repository` | Configured least-privilege service PAT |
| Bitbucket Cloud | `https://bitbucket.org/workspace/repository` | Configured service bearer token, or service username and token |

Bitbucket Server/Data Center is outside the agreed scope. Arbitrary hosts are
not accepted unless an administrator registers an HTTPS connection. Pagination
cannot send credentials to a different host or repository. API redirects are
rejected.

## Server configuration

Set `SOURCE_CONNECTIONS` to a JSON array through a secret manager, not a
`NEXT_PUBLIC_` variable. The production Bicep parameter `sourceConnections`
stores it in Key Vault and injects references into web, worker and outbox.
Example shape, with placeholders rather than usable credentials:

```json
[
  {
    "provider": "gitlab",
    "origin": "https://gitlab.example.com",
    "pathPrefix": "/approved-group",
    "token": "<service-token>"
  },
  {
    "provider": "azure-repos",
    "origin": "https://dev.azure.com",
    "pathPrefix": "/approved-organization",
    "token": "<service-pat>"
  }
]
```

`pathPrefix` binds a credential to an approved namespace; the longest matching
prefix wins. Duplicate bindings are rejected. An optional `apiBaseUrl` overrides
the provider's API root for approved enterprise installations. Optional
`username` selects Basic authentication where the provider requires it.
Rotate service credentials, limit repository access and avoid personal accounts.
GitHub.com continues to use the App, not this token configuration.

The Settings page exposes provider/origin/configured status only. Configured or
readable does not imply write permission. Providers enforce write permissions
when the already-approved proposal is published.

## Publication safeguards

The source branch must still match the approved commit. Publication uses a new
target branch, preserves existing executable-file modes and never force-pushes
the source. Existing target content must match the approved source-bound
proposal for an idempotent retry; conflicts are not overwritten. New pull/merge
requests must be confirmed as drafts by the provider.

## Qualification

HTTP contract tests cover parsing, pinned snapshots, pagination isolation,
source drift, publication request shapes, executable modes and draft requests.
These are not a substitute for authenticated live canaries for every configured
provider/version. Do not mark an enterprise connection production-qualified
until its dedicated canary exercises inspection, generation, verification,
independent approval, branch creation and draft publication.
