# Operator planning popup repair and audit

User request: log the popup and fix the TOB01263 planning-alert defects.
Spec approval: not obtained (autonomous run). Tier 2, with concurrent retry and
authorization checks. See `operator-popup-spec.md` for the acceptance contract.

The repair permits blank parking spots, refreshes after
`dispatch.plan.followups.completed`, and combines explicit group references with
newly changed linked-order notices. Each popup instance reports queued,
displayed, opened and dismissed to the existing Control audit. The server supplies
the authenticated actor and canonical order reference and enforces yard access.
The audit is searchable by order reference and `delivery.popup.*` action.

## Acceptance evidence

| Spec | Executable evidence |
| --- | --- |
| 1 | Browser P1: TOB01263, Load 4, blank parking spot displays and reports the popup. |
| 2 | Browser P2: save arrives before assignment; follow-up completion alone wakes the popup. |
| 3 | Browser P3: group-only explicit references retain the newly planned linked TO. |
| 4 | Browser P4: dismissal survives repeated events; a changed load alerts again. |
| 5 | Browser P1/P4/P5, HTTP A1: display/open/dismiss identity and searchable authenticated audit. |
| 6 | Browser P6, client L1–L3, HTTP A2: nonblocking outage, bounded retries, same-session delivery, eight concurrent duplicate submissions. |
| 7 | HTTP A1/A3/A4, validator V1/V2: canonical actor/order, login and yard rejection, malformed payload rejection, 200 generated optional-field cases (seed 1263). |
| 8 | Browser P7: hidden tab queues without claiming visible display; visibility resumes display logging. |
| 9 | Existing delivery-refresh, performance, service-worker and yard-access suites; exact release-source hashes and app-only configuration verification. |

The new browser cases failed against the old behavior. The endpoint assertions
failed with HTTP 404 before the route existed. Existing yard guards already
passed and remain regression protection. The final checks deliberately restore
four plausible bugs: blank-spot suppression, missing completion event, missing
display receipt, and duplicate audit insertion. Each must fail its targeted test.

## Reproduction and scope

From the repository root, before deployment, run:

```sh
python3 server/tools/operator-popup-release.py validate
```

This checks the captured candidate against unchanged live-source hashes and uses
the repository's disposable runner, bounded Compose configuration and
`mbbs-tests.slice`. The runner removes containers, disposable database storage,
networks, browser coverage and logs and verifies both container lists and health.
After deployment the same candidate tests can be rerun without the pre-release
live-drift check:

```sh
DISPATCH_SOURCE_SKIP_BUILD=1 \
DISPATCH_SOURCE_RUNTIME="$PWD/server/deployments/operator-popup-20261026/candidate" \
DISPATCH_SOURCE_MIGRATIONS="$PWD/server/deployments/operator-popup-20261026/candidate/migrations" \
python3 docker/retention/retention.py run --root /tmp -- \
bash docker/run-dispatch-source-tests.sh node tools/operator-popup-checks.mjs
```

The persisted check script performs syntax checks, scoped ESLint and complexity
checks, a secret scan, scoped TypeScript diagnostics, deterministic shuffled test
file order, Node/browser coverage and manual mutation. Tool versions, source
hashes, test hashes and final results are in the release's `validation.json`.
The final runtime and HTTP checks are in `deployed.json`.

Final candidate results: 84 cases, 83 passed, one independently reproduced
baseline failure, zero new failures, zero skips. All 16 new popup cases passed;
all four manual mutants were killed. Both new modules have 129/129 executed
lines, 10/10 functions and 64/70 Node-measured branches (91.42%). The browser merge
also covers 48/48 changed executable Operator lines and 62/62 client-helper lines.
The merged client helper has 34/37 covered branch ranges (91.89%); backend branch
coverage is 33/35 (94.28%). No claim of complete branch coverage is made.
Scoped lint, syntax and secret checks passed. The new backend module has zero
TypeScript diagnostics; the imported legacy graph reports 8,609 diagnostics
outside this module, so this is not a clean project-wide typecheck.

Validated candidate tree SHA-256:
`7281e40aaab749a63dc982fcd03fb5f2caa5f48a0e691bb5515e60a5c26d050a`.
Recorded tools: Node 20.20.2, ESLint 10.8.0, TypeScript 7.0.2, c8 12.0.0,
Playwright 1.62.1, fast-check 4.9.0 and v8-to-istanbul 9.3.0.
The entire check command was rerun after preserving a concurrent eight-file
Frontdesk release; all seven popup release files retained their validated hashes.

The full repository suite and whole-file type/lint checks of the large legacy
Operator/server modules are outside this focused repair. Syntax and exercised
runtime behavior cover the integration edits; type/lint checks cover the new
module. No dependencies, database schema or credentials were changed. No commits
were created; source hashes identify the tested release and verify mutant restore.

## Baseline and limitations

The existing test `yard lists and saved queues withhold unauthorized groups while
preserving authorized standalone orders and saved rows` fails on both unchanged
live source and the candidate: `saved-orders?locationId=1`, `500 !== 200`. The
baseline error is PostgreSQL rejecting the synthetic `GRP-YARD-<UUID>` as bigint.
The unchanged baseline run passed 35 of 36 cases. `operator-popup-baseline.json`
records the source hashes and reproducible command. The test remains enabled;
the final comparison permits only this exact previously observed failure.

The existing pickup-polling browser test initially failed under concurrent host
load because it assumed a response after 30 ms. Its setup now awaits the first
HTTP response; all behavioral assertions remain unchanged. Coverage collection
was corrected to identify VM source by its absolute path, allowing the actual
client retry tests to contribute to coverage. These changes are test scaffolding.

Displayed is a client report of an in-app banner in a visible document, not proof
that a human read it or that an OS notification appeared. Logging starts with the
new client; it cannot establish whether the earlier TOB01263 popup was seen.
Retries are in memory, at most three attempts, and stop across session/yard
changes. Reloads or extended outages can lose unsent receipts. Server retry
deduplication covers 48 hours. Popup suppression is scoped to the current client
session. The browser tests replace network boundaries; the HTTP tests use the real
application and an isolated PostgreSQL database. Production verification does not
create synthetic business records or popup receipts.

## Deployment verification

Deployed 2026-10-26T21:21:24.855029+00:00 as `mbbs-operator-app:operator-popup-20261026`. The built image and live runtime matched all 1517 captured runtime-file hashes. Local and public health checks returned 200; all four changed public assets matched their source hashes and three anonymous API probes returned 401. App configuration and dependency containers were preserved. The preflight found no executing business operations. Rollback image: `mbbs-operator-app:operator-popup-20261026-rollback`. Both running and stopped container lists contained only the four production containers; no disposable containers remained. Disposable test logs, coverage, temporary copies, storage and networks were removed.
