# Modernization strategies and acceptance

Scope selects the application layers. Strategy selects the kind of change.
Neither selection is permission to remove behavior or bypass verification.
Legacy runs without a strategy remain `refactor`.

| Strategy | Additional minimum acceptance |
| --- | --- |
| `upgrade` | Baseline/candidate runtime build, tests and audit |
| `refactor` | Baseline/candidate runtime build, tests and audit |
| `replatform` | Candidate image build and container smoke-test harness |
| `extract-services` | Same baseline/candidate contract harness; candidate integration |
| `rewrite` | Same reviewed runtime-independent contract harness on both variants |
| `database-migration` | Candidate fixture migration and rollback; baseline/candidate data parity |
| `ai-capability` | Candidate AI acceptance and authorization checks |

Service extraction, backend rewrites and database migration require backend or
full-app scope. Production databases, live deployment and cutover are never
performed by generated code inside the platform.

## Acceptance manifest

Specialized strategies require `tests/modernization-acceptance.json`. Its contents
are part of the reviewed changeset and verification digest. Each check identifies
its real executable, variants, bounded timeout and machine-readable result file.

```json
{
  "version": 1,
  "scenario": "rewrite",
  "checks": [
    {
      "id": "public-http-contract",
      "kind": "contract",
      "project": ".",
      "variants": ["baseline", "candidate"],
      "command": "node",
      "args": ["tests/modernization/http-contract.cjs"],
      "report": {
        "path": ".modernize-reports/http-contract.json",
        "format": "json"
      },
      "timeoutSeconds": 240
    }
  ]
}
```

The referenced harness must actually start the appropriate baseline/candidate
application, exercise preserved behavior and write its results. This example
does not supply a no-op passing test. JSON uses Jest/Vitest counters
`numTotalTests`, `numPassedTests`, `numFailedTests`, `numPendingTests`; JUnit and
Node TAP reports are also supported. Output reports must be under
`.modernize-reports/`, are cleared before execution, and must show executed tests
without failures or skips.

Additive shared harness files belong under `tests/modernization/`. They may be
copied into the isolated baseline, but original harness files cannot be
overwritten. A cross-runtime rewrite requires a reviewed source contract, not
two unrelated generated unit suites. Missing tools, fixtures, application
dependencies, reports or live integration prerequisites block verification.

There are at most 12 checks, 900 seconds per check and no implicit shell command
parsing. All repository commands use the variant's unprivileged identity and
sanitized environment. No production secrets are supplied.

## What a pass does not establish

A project-provided harness may be incomplete. An AI test can exercise mocks
without reaching a cloud service. A schema test is not a data migration rehearsal.
An image definition is not an image build. Review the harness and command logs;
retain application-specific acceptance, real integration qualification,
performance, accessibility, restore and release approvals as separate gates.
