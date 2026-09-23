# Isolated Verification

Node/npm and Python verification run in an ephemeral Azure Container Apps Job, not inside
the web or worker container. Configure `VERIFICATION_JOB_RESOURCE_ID` and
`VERIFICATION_PUBLIC_ORIGIN` on web and worker. Deploy `infra/verification.bicep`
with the existing Container Apps environment ID and starter principal IDs.
Apply database migration `007_verification_jobs.sql` before deploying web.

The job has no managed identity, production secrets, ingress or shared volumes.
It has 2 CPUs, 4 GiB memory and a 30-minute execution limit. The supervisor uses
a random 45-minute capability limited to one job's snapshot and report. Each
repository variant executes under a separate non-root UID with a sanitized
environment; source, output and production credentials are not shared between
variants. Public network access is required for the npm registry. This is not a
network-isolated or penetration-tested hostile-code sandbox; use a dedicated
environment and controlled egress before admitting untrusted external tenants.

Source is fetched from the exact recorded commit, including binary blobs, and
the proposed changes are applied without creating a GitHub branch. Truncated
trees, symlinks, submodules, tracked credential files, more than 3000 files or
30 MB of source are rejected. GitHub/Foundry credentials stay in the dispatcher.

Every baseline npm project must have a package-lock.json before generation.
New or changed candidate manifests have their lockfile resolved with
`npm install --package-lock-only --ignore-scripts --no-fund` in the candidate's
unprivileged sandbox. Only bounded, user-owned regular lockfiles matching a
snapshot manifest are accepted; symlinks and source-code artifacts are rejected.
The server atomically persists candidate lockfiles, updates the changeset digest,
invalidates older reports and records an audit event before tests start. Human
approval therefore covers the resolved dependency changes too.

Explicit build/test scripts are
required for a passing result. If either script is absent or empty, the runner
executes the remaining available checks and records their logs, then reports
`unsupported` with the missing script names. Missing scripts never count as
passed checks; approval stays blocked. A baseline audit failure is retained while
candidate checks continue, so existing dependency findings do not hide candidate
results. A completed baseline audit reporting high/critical vulnerabilities is
diagnostic when candidate audit passes and all mandatory build/test commands pass
on both variants. Baseline audit timeouts, network failures and other errors still
block approval. Missing tests are never waived. Other command failures stop
execution and are recorded together with known missing prerequisites.
Workspaces use their root scripts. The current test invocation is suitable for
Vitest and scripts accepting `--run`; incompatible test scripts fail explicitly.
No script or missing dependency is invented to make verification pass.

For a legacy source with no existing test command, a reviewed
`tests/baseline-harness.json` can record a baseline manifest, lockfile and the
Vitest/jsdom/Testing Library dependencies needed by the common suite. Only the
test command and allowlisted development dependencies may differ from the source
manifest. Existing runtime scripts and dependencies remain unchanged. The common
candidate tests are copied into the isolated baseline; existing baseline test
files cannot be overwritten. This overlay is a visible candidate file included
in the changeset digest. It does not modify the GitHub source branch. Its
dependency install and audit results are reported like other baseline checks.

For npm projects with no test command, the platform can also copy additive
candidate tests and allowlisted Vitest tooling into a baseline sandbox. Its
manifest retains the original runtime fields and existing dependency versions.
The baseline test-tooling lock is resolved separately and cannot change locked
runtime packages. It is not copied into the candidate or committed to GitHub.
An incompatible baseline test harness fails; it is never skipped to obtain a
passing candidate.

The Admin-only repair endpoint accepts version-locked dependency and test
integration files, binds their before-content to the pinned GitHub source and
records an audit event. It refuses active generation/verification and invalidates
old evidence. It never approves or publishes a proposal.

For both baseline and candidate, the supervisor executes:

1. `npm ci --ignore-scripts --no-fund`
2. `npm run build`
3. `npm test -- --run`
4. `npm audit --omit=dev --audit-level=high`

Each command is limited to four minutes, captures its exit code and the last
32,000 log characters, and terminates its process group on timeout. Dependency
install hooks are disabled; a project requiring them may need an explicitly
reviewed build strategy. Existing tests can be weak or misleading: passing
commands do not prove complete behavioral equivalence, correct architecture,
coverage, security or enterprise readiness.

Approval and publication require the latest passing report for the exact source
SHA and changeset digest. Edits make older reports stale. A successful report
does not publish anything: human approval is still required. The Verification tab
can start verification for existing blocked runs and displays command logs.
Generation requires a configured verifier and starts it automatically. Dispatches
with no report after ten minutes can be recovered by the worker, at most three
times per hour. Recovery invalidates the abandoned job capability and does not
replace active reports or touch approved runs. Failed checks still need repair;
recovery is not an automatic pass or automatic behavior exception.

Run processing uses a tenant/run advisory lock and per-attempt fencing token.
Cancellation and terminal-state checks precede candidate persistence. Refinements
and edits require stopped, unapproved runs, invalidate the old verification and
persist a pending request so queue delivery failure is recoverable. An ambiguous
Service Bus send leaves a saved run queued, not a misleading new-run failure.
Cancellation does not guarantee instantaneous cancellation of an external model
request; its late results must not be persisted.

The capability expires automatically. Snapshot payloads are removed after a
terminal report; expired payloads are cleared on a subsequent verification
request. Define an additional periodic retention policy for abandoned jobs and
execution reports according to organizational requirements.