# Special Request manual links and request-based PO creation

Tier 3: commercial data, ownership, concurrency and duplicate transactions.
Spec approval: not obtained (autonomous repair). The user explicitly clarified
manual linking and confirmed existing synced order references. Acceptance
criteria and intentional contract updates are in
`test/special-po-reference-only-spec.md`. No new dependencies, migrations or commits.

Source identity: six-file SHA-256 manifest in summary.json; deployed image
`sha256:4f7c3a2c46f9024db7b6b6342814efc8ebc902c4e99182030ac19651bca99fac`. All six baseline files matched production. Deploy only
this overlay and preserve the environment and other production services.

Reproduce from the repository root:
`python3 server/tools/special-po-reference-only-20261006/run.py all`.
The standard isolated Compose configuration provides mbbs-tests.slice, init,
labels, memory/swap, PID, CPU and tmpfs limits. Register teardown before startup;
remove containers, database volumes and networks on completion or interruption.
Toolchain: v20.20.2, cached test image in run.py, project dependency lockfile.

| Acceptance criterion | Executable evidence | Result |
| --- | --- | --- |
| Manual SO/PO link a unique synced number without business comparisons or draft edits | reference-only, manual-SO, custom-PO and unsubmitted-operation HTTP/database tests | pass |
| Keep authorization, revisions, identity, case ownership and submission integrity | existing manual/custom guard scenarios and submitted-operation snapshot | pass |
| Show request materials without mappings or drafts, even with pending SO approval or an unrelated old draft | reference-only browser tests on desktop and phone; existing Sales browser | pass |
| Preserve SCM-confirmed purchase review and accept an explicit 0 percent discount | reference-only browser/database tests | pass |
| Persist all standalone purchase lines, replace on retry, reject invalid/duplicate/foreign/stale input atomically | reference-only integration tests | pass |
| Create reviewed request PO with correct units, gross costs, combined discount, marker and SO note; no SO access or synchronization | actual local NetSuite HTTP transport; service property, 40 generated inputs, seed 26100638 | pass |
| Ignore SO-native pointers; preserve app-marker recovery and no automatic resubmission | existing-native-pointer scenario, lost-response and invisible-marker tests | pass |
| Competing attempts yield one durable PO submission | real repository concurrent creation test | pass |
| Keep linking independent from arrangement and mirror readiness | delayed mirror/webhook and route tests | pass |

| Validation layer | Observed result |
| --- | --- |
| Full affected Special Request suite | Baseline: 947 tests, 855 pass, 92 fail, 0 skip. Candidate: 948 tests, 882 pass, 66 fail, 0 skip. Zero new failures. |
| Focused tests | 47 pass, 0 fail |
| TypeScript/checkJs | All changed JS modules plus dependencies: 8762 baseline diagnostics, 8758 candidate diagnostics; zero new diagnostics |
| Lint and syntax | Changed JS, focused tests and runner; zero errors/warnings; syntax passes |
| Changed lines | 113/113 covered by c8/server and Chromium/page coverage; lines saved in summary.json |
| Manual mutation | 7/7 killed; both manual-SO synchronization and native-recovery mutants killed by the property suite alone |
| Test order | Reversed focused order: 47 pass, 0 fail |
| Secret scan and dependencies | Diff scan passes; no dependency changes |
| Live verification | SPREQ-000038, SO SOA09865: request materials, deployed service and served page verified read-only |
| Deployment | Six-file overlay; production configuration and other services preserved; health healthy |
| Cleanup | No task containers, database volumes or networks; docker ps and docker ps -a saved |

Existing failures are listed in summary.json with baseline.log/candidate.log.
The clarified baseline RED run reproduces behavioral failures without setup
failure. Earlier setup corrections and intentionally superseded native-recovery
work are described in the spec and kept in archived evidence. Manual SO draft
line identities are now deliberately left unchanged; app-created-order fixtures
explicitly select standalone source to retain strict matching and synchronization
coverage. Previous contract test versions are saved under previous-contract-tests.

No live NetSuite transaction or SO update was submitted during validation.
SPREQ-000038 is verified from a read-only database transaction. Purchase creation
uses a local HTTP transport for NetSuite and the real application repository.
A narrowly scoped mutation loop, generated property cases and concurrent/retry
checks were executed; no mutation-tool score or external NetSuite sandbox run is
claimed. Existing type diagnostics and unrelated baseline failures remain.
No separate performance budget or dependency changes were requested; unrelated
application suites and supply-chain audits were not rerun.
