# Scoped Analysis and Architecture

Users select Frontend, Backend or Full app before repository recommendations.
The selected scope is sent to both recommendation and architecture analysis.
Model normalization does not override it. Out-of-scope runtime targets are omitted
from launch requests. Changing repository, branch or scope invalidates the prior
recommendation. User-entered target branch names are preserved.

Dependency manifests and runtime/build configuration take priority over source
samples. Recommendation and architecture analysis read at most 24 files of at
most 80 KB each. Before generation, the worker fetches the complete pinned
snapshot and includes all UTF-8 text except dependency lockfiles. A context over
1 MB is rejected instead of silently truncated. Snapshots remain limited to
3000 files / 30 MB, without symlinks, submodules or tracked credential files.
GitHub App and public-source reads are pinned to the resolved source commit.

Readiness checks run before recommendations, final analysis and launch, and are
repeated by the worker. They read manifests server-side rather than trusting the
browser. Source runtimes without an installed verifier, non-npm package managers,
missing baseline npm lockfiles and unsupported backend targets are rejected.
Current executed runtimes are Node/npm and requirements-based Python. New Python
or npm tests may be generated, but missing checks never count as a pass.
Live analysis no longer substitutes demo data when Foundry is unavailable.

Evidence records detected manifests, read and omitted manifests, lockfile paths,
sampled source paths, and declared npm dependency/runtime/workspace fields. Other
supported manifest formats are provided as source text. Lockfiles are inventoried,
not exhaustively parsed. This is not an import/call graph, SBOM, compatibility
proof or support for executing every detected ecosystem. Python/npm execution
and its gates remain a separate verification phase.

Generation validates returned change areas against user scope as well as agent
ownership. Obvious other-layer paths are rejected. Platform/shared-file scope
still requires review; path and area checks are not semantic proof that a shared
dependency change preserves all consumers. Frontend and backend contract tests
are required to detect integration drift.

## Coordinated Generation

Architecture establishes a schema-validated contract before implementation. The
contract records runtime projects, interfaces, authentication and preserved
behavior requirements with verification expectations. It is persisted as
`docs/modernization-contract.json` in the changeset for human review.

Backend runs before frontend; each subsequent agent receives the accepted
candidate files and shared contract. Optional Cloud runs next, then Security
and Testing review the assembled candidate. An agent may explicitly report no
changes. Original source tests cannot be deleted or rewritten by generation.
Model-written lockfiles are rejected; npm produces them in the isolated runner.
Final diffs remain bound to the original source, including after refinements.

A written contract is not proof that generated implementations follow it.
Executed characterization, HTTP/API integration and application-specific
acceptance tests remain necessary. The input size limits also mean this is not
an unrestricted whole-enterprise modernization engine or a complete static
dependency graph.

New runs persist a schema-validated architecture analysis in run options,
including repository, branch, source commit, scope, current/proposed nodes and
dependency evidence. The worker refuses to generate from a different source SHA.
Architecture GET is tenant-scoped and returns the latest saved target revision
when present. Components are displayed as logical groups, not asserted network
connections or deployed resources.

Older runs may have architecture documents but no saved AI analysis. Architecture
displays their actual generated documents and an explicitly labelled component
inventory derived from changeset areas. It does not reconstruct or claim the
missing original diagram or dependency evidence. The Agent team navigation item
opens the selected project's specialists directly; Execution retains its compact
Status, Changes, Verification and History views.