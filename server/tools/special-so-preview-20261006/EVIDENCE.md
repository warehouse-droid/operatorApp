# SPREQ-000030 / SOB122131 completion evidence

2026-10-06. **Spec approval: not obtained (autonomous run).** The user explicitly
confirmed keeping the existing NetSuite lines. Confidence is based on the
executable checks and live comparisons below; there was no separate human review
of the specification or code. Specification: `test/special-so-preview-20261006-spec.md`.

## Finding and resulting behavior

The three SQFT quantities (99.79, 95.94, 287.82), rate 5.98, and UOM 866 matched.
The PC material quantity 96, rate 5.41, and UOM 865 also matched. Delivery Charge
1987 correctly has no Units. The old verifier compared actual null units to
`Number(undefined)`/`Number(null)` and rejected a valid unitless fee. The fix
normalizes absent expected units to null while retaining exact material-UOM,
quantity, price, description, pack, customer, location, and discount checks.

The current SO also has intentional commercial differences: the extra $235
special-item `DELIVERY CHARGE` line was removed and a -$100 `reversed delivery fee`
line was added. These remain valid reasons for exact draft verification to reject
that SO. The user approved those differences; this case was recovered using the
existing manual-reference workflow. The regular $235 Delivery Charge remains.

Before SO creation, Pickup → Delivery now displays and saves the delivery fee.
The save updates one unitless Delivery Charge in an existing SO draft. Pickup
removes that managed charge. Zero fees are accepted; legacy unset fees remain
optional. Materials, PO costs, checks, decisions, progress, and notes are retained.

## Specification mapping

| Behavior | Evidence |
| --- | --- |
| Unitless fee, exact SQFT, null/absent and scalar/reference units | `test/mbt/unit/special-so-unitless-verification.test.js`: exact fixtures and generated acceptance/rejection cases |
| Genuine commercial, UOM, pack, customer, yard, and missing-line differences reject | Same unit file: twelve adversarial changes; existing recovered-discount and native-REST pack regression tests are included in the wider suite |
| Fee appears, retains edits, submits, accepts zero, hides for Pickup | `test/mbt/integration/special-header-note-browser.test.js`: desktop and phone tests, save-error and rerender checks |
| Atomic fee persistence and one unitless draft charge; materials and PO costs preserved | `test/mbt/integration/special-header-note-http.test.js`: Pickup/Delivery/zero transitions and quote checks |
| Invalid/stale/concurrent saves, authorization, audit-write failure | Same HTTP file: unchanged-row, serialization, role/yard, workflow-gate, and rollback assertions |
| Existing order recovery, historical rows preserved, actual PDF | `recover.mjs`, `recovery-apply.log`, `live-completion.json`, and private operational before-state snapshots |
| Resource bounds and complete disposal | `run.py`, standard `docker-compose.mbt-test.yml`, `cleanup-audit.json`, and `cleanup-completion.json` |

## Validation results and limits

All results refer to the final runtime/test hashes in
`test-artifacts/special-so-preview-20261006/summary.json`. No runtime or test edits
were made after these checks. The final `audit` run repeated focused, coverage,
mutation, type, lint, syntax, secret, and order checks; it reused the preceding
fresh baseline/candidate broad-suite logs for the same source hashes. These were
several executions, not a claim that every layer ran in one command invocation.

| Layer | Result |
| --- | --- |
| RED | Unit, HTTP, and real-browser regression failures reproduced against baseline behavior; setup-only failures were excluded |
| Focused | 23/23 passed, 0 failed, 0 skipped |
| Coverage execution | 29/29 passed; combines focused checks and six existing shared-header tests |
| Wider Special workflow baseline | 908 tests: 836 passed, 72 failed |
| Wider Special workflow candidate | 911 tests: 844 passed, 67 failed; **0 new failure names** |
| Generated checks | 100 deterministic cases, seed 2026100630; exact acceptance plus changed material-UOM and fee-rate rejection |
| Changed executable lines | 22/22 executed using c8 and exact-source browser coverage; no 100% whole-file or branch-coverage claim |
| Manual mutation | 5/5 killed: unitless comparison, ignored material UOM, ignored price, omitted draft fee, omitted fee field |
| Independent property mutation | All three verifier mutants also killed by the generated test alone |
| Order check | Reversed focused file order: 23/23 passed; no claim of randomized full-suite stability |
| Types | Passed for REST verifier and shared fulfillment editor; full repository JS type checking was outside this task |
| Lint/syntax/secrets | Passed for the listed task runtime/test files; recorded commands are in `check.mjs` |

The wider suite remains unhealthy: 67 failures were already present against the
baseline. Their exact names and logs are retained in `summary.json`,
`baseline-special.log`, and `special-regressions-final.log`. Five planned header
regressions disappeared; three new verifier tests passed. Unrelated repository
suites and dependency/license scans were not run; no dependencies were added.
The original failed broad attempt included host-artifact permission errors and
shared-database fixture contamination. The harness was corrected to use writable
ephemeral copies and separate fresh baseline/candidate databases; failed-attempt
logs remain. Browser configuration was given bounded writable /tmp directories.
The existing browser `history` global was declared for lint rather than altering
application logic or relaxing lint rules.

Recorded tools: Node 20.20.2, TypeScript 7.0.2, ESLint 10.8.0, c8 12.0.0,
fast-check 4.9.0, Playwright 1.62.1. No dependency or schema changes and no commits.

## Deployment and request recovery

Only five tested runtime files were overlaid on the then-current production
image; source and configuration hashes were checked before and after the restart.
The existing DB, worker, and Ollama container configurations were retained. The
deployment rejected active foreground operations before restart, checked app
health, and preserved an exact rollback image.

Candidate image:
`sha256:81316d36e88623a7554099fad5602c93602377750c52f213cdacedcdd4fbe1a8`.
Base/rollback image:
`sha256:718fcfe39a6999c158f0e3f5fc100e2b935fcad7a4abaaac0fd50b78f528dd5a`.
Exact file hashes are in `deployed.json` and the release manifest.

Recovery re-read NetSuite and verified SO identity, unique external ID, customer
5409, yard 1, unchanged commercial lines, no shipment/billing/closure, and no
competing request owner. During work, NetSuite added existing POB03995 (1042198)
references to the material/PALLET lines. The first guard stopped with **no
application write**. After verifying that only these PO references changed, the
recovery preserved them and recorded them in the audit.

A subsequent guard compared different audience projections of the same draft
(SCM includes purchase costs, Sales omits them) and rolled the whole transaction
back. The check was corrected to compare the same SCM view and additionally every
raw stored material/order row. Both stopped attempts are preserved as
`recovery-apply-original-guard.log` and `recovery-apply-audience-guard.log`.

Successful recovery linked SPREQ-000030 revision 21 to SOB122131 (1041956), source
`manual_link`, operation status `linked`, attention false. Historical application
material/SO/PO drafts were preserved exactly and one recovery audit was recorded.
No order was created, repriced, or written in NetSuite. POB03995's NetSuite
references remain; the request's PO link was not changed. The historical reviewed
draft still contains the original charge lines; the preview uses the actual
NetSuite order.

Sales and SCM preview availability was verified through the normal document
snapshot path. The actual PDF was retrieved through the existing document
service: 37,914 bytes, SHA-256
`d35099e276d416ebee5e37cb4911f7e6f8f3109369c86c9af64e0bbe6cd4cc75`.
The PDF and before-state backups are in the protected operational directory
`/home/ubuntu/operatorapp-investigations/special-so-preview-20261006/private/`.
Final production health passed.

## Reproduction and cleanup

From `server`, `python3 tools/special-so-preview-20261006/run.py all` reruns the
isolated gauntlet and teardown. It requires Docker and the recorded cached test
image `mbbs-delivery-requests:final`
(`sha256:e0051d1aa1c279a31eaf8c958301fd9ee80e5be77564883b1c3c346983272fd9`);
rebuilding that pre-existing image on another host is an environment prerequisite.
All test and mutation commands are persisted in `check.mjs`; product/test source
hashes and tool versions are in `summary.json`. Production recovery is state
guarded and intentionally cannot be replayed after success.

`python3 tools/special-so-preview-20261006/verify-live.py` performs read-only live
completion checks. Test teardown was registered before startup, all workloads
used `mbbs-tests.slice` and the standard per-container limits, and every task
environment was removed with `down --volumes --remove-orphans`, including failed
runs. Final `docker ps` and `docker ps -a` contain the four production containers
and no disposable test containers. Task test volumes and networks are absent.
Logs, PDFs, audit records, and rollback data were retained.
