# Python Verification

The isolated supervisor detects `requirements.txt`, Poetry/uv `pyproject.toml`
with the corresponding lock, and Pipenv `Pipfile`/`Pipfile.lock` projects, in addition to JavaScript
projects. Mixed repositories must satisfy both command matrices before approval.
Python currently supports Python 3.11 on Debian, binary pip dependencies, and
standard-library unittest discovery under each project's `tests/test_*.py`.
Poetry, uv and Pipenv preserve their source lock owner: an accompanying
`requirements.txt` is not substituted for the lock. Missing/competing manager
locks block verification. Python versions incompatible with the installed
3.11 toolchain fail explicitly; alternate Python versions are not yet qualified.

Each baseline and candidate project receives its own virtual environment.
Commands install requirements or synchronize every locked dependency group,
compile Python sources, run unittest under Xvfb,
and audit installed runtime dependencies using pip-audit 2.9.0. Zero tests,
skipped tests, test failures, installation failures and candidate audit findings
block approval. A complete baseline pip-audit JSON report containing known
vulnerabilities remains diagnostic only when candidate checks are clean. Audit
transport errors, malformed or unresolved-package reports still block approval.
Python compilation checks syntax, not application behavior.
Unittest emits structured test counts; both runner and server reject missing,
zero, failed, skipped or expected-failure counts. A zero exit code alone is not
test evidence.

Poetry 2.2.1, uv 0.9.9 and Pipenv 2025.0.4 are installed from wheels before repository
materialization and their versions are checked. Source builds are disabled for
privileged Python tool installation. Poetry executes
`sync --all-groups --no-root`, uv executes
`sync --frozen --all-groups --no-install-project`, and Pipenv executes
`sync --dev`. The source's Python/tool compatibility constraints still apply;
incompatible source declarations are not rewritten. Project build backends and
dependency installation execute only as the variant UID. Poetry/uv use
`.verification-venv`; Pipenv uses `.venv`. Compilation excludes that environment,
and pip-audit scans its installed site-packages, not a silently exported
requirements file. Candidate lock regeneration is performed only by its manager
as the candidate UID, recorded server-side and included in the review digest.
Baseline Poetry/uv/Pipenv manifests and locks are never rewritten to add tooling.

When a Python project lacks generated tests, candidate Python files under its
`tests/` directory are added to the isolated baseline snapshot. Existing test
files cannot be replaced. Runtime code and requirements remain unchanged.
The candidate tests are part of the source-bound changeset digest. This allows
the same characterization assertions to run against original and changed code.
The original GitHub branch is never modified by this overlay.

Projects may declare `requirements-dev.txt` for test tooling. Its installation is
a separate mandatory report step, constrained by `requirements.txt`; runtime
installation and audit remain required. Baseline overlays accept only exact
pins of allowlisted tools (httpx, pytest, hypothesis, coverage, pytest-cov), not
arbitrary pip directives or replacement runtime requirements. Empty or skipped
suites remain failures after tooling is installed.

The supervisor sets `MODERNIZE_VERIFICATION_VARIANT` to `baseline` or `candidate`.
An explicitly reviewed behavior exception may use it to preserve the original
baseline assertion and assert the approved new candidate behavior. The exception
and both assertions must be present in the reviewed changeset; it must not be
used to skip tests or silently accept unrelated behavior differences.

Runtime preparation installs Debian Python, Tkinter, Xvfb and audio libraries
before repository materialization. Preparation runs trusted fixed commands;
repository commands run as separate non-root users with sanitized environments.
The job has no Azure identity or production credentials. Package registry/network
egress is available. Plain requirements with ranges remain non-hermetic;
Poetry/uv/Pipenv synchronize their reviewed locks. This is not a network-isolated
build or a guarantee that native/hardware dependencies can execute.

GUI tests use a virtual display. Speech SDK mocks do not prove real microphone,
speaker diarization or Azure Speech integration. Live-service and hardware
acceptance remains separate. Missing tests in newly generated backend/frontend
projects are reported rather than replaced with placeholder passing checks.