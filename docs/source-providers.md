# GitHub repository access

GitHub.com is the only supported source provider. Use the canonical
`https://github.com/owner/repository` URL; an optional `.git` suffix is normalized.
Other hosts, embedded credentials, query strings, fragments and file/branch URLs
are rejected before any source request.

## Authentication and permissions

Configure `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` and `GITHUB_WEBHOOK_SECRET`
server-side through approved secret storage. Install the App only on approved
repositories. Analysis and generation use short-lived read-only installation
tokens. Publication requests write permissions only after explicit,
source/digest-bound human approval. Production requires an independent reviewer.
An explicitly enabled pilot administrator exception requires acknowledgement
and is separately audited; it never waives execution evidence or source binding.
Workflow-file changes require the App's
additional workflow permission. Personal access tokens and browser-supplied
source credentials are not used for unattended writes.

The Settings page reports App configuration, not assumed repository access.
Each run verifies installation access for its selected repository and branch.
Public read-only recommendations may fall back to unauthenticated GitHub reads,
but live generation and publication still require the installed App.

## Snapshot and publication safeguards

Analysis, generation, repair and verification read the recorded source commit.
Snapshots are bounded to 3000 files / 30 MB. Truncated trees, symlinks, submodules,
unsafe paths and tracked credential files are refused. Credentials never enter
run options, model context or repository snapshots.

Publication checks the approved source SHA, preserves file modes, creates only a
separate branch and draft pull request, and refuses conflicting target branches.
Retries may recover an existing matching branch/PR without overwriting it.

## Qualification

Release acceptance requires a dedicated GitHub repository canary exercising
authenticated inspection, generation, isolated baseline/candidate verification,
independent approval and draft PR publication. The source branch must remain
unchanged. Retain the run ID, source SHA, verification digest, approval and PR as
evidence. Mock HTTP tests do not replace this live acceptance.
