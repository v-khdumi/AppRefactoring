# Python Verification

The isolated supervisor detects `requirements.txt` projects in addition to npm
projects. Mixed repositories must satisfy both command matrices before approval.
Python currently supports Python 3.11 on Debian, binary pip dependencies, and
standard-library unittest discovery under each project's `tests/test_*.py`.
Poetry, uv-only manifests and other runtimes are not implemented.

Each baseline and candidate project receives its own virtual environment.
Commands install requirements, compile Python sources, run unittest under Xvfb,
and audit installed runtime dependencies using pip-audit 2.9.0. Zero tests,
skipped tests, test failures, installation failures and candidate audit findings
block approval. A complete baseline pip-audit JSON report containing known
vulnerabilities remains diagnostic only when candidate checks are clean. Audit
transport errors, malformed or unresolved-package reports still block approval.
Python compilation checks syntax, not application behavior.

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
egress is available; dependency versions with ranges are resolved during each
execution, so this is not a hermetic or reproducible Python lockfile pipeline.

GUI tests use a virtual display. Speech SDK mocks do not prove real microphone,
speaker diarization or Azure Speech integration. Live-service and hardware
acceptance remains separate. Missing tests in newly generated backend/frontend
projects are reported rather than replaced with placeholder passing checks.