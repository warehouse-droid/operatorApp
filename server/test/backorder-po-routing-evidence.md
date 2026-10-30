# Backorder PO routing evidence — 2026-10-29

Spec approval: not obtained (autonomous run). Tier 3 for order attachment and
HTTP authorization. The user explicitly chose to keep STREQ-000166 attached to
the whole POB04147. No dependencies, schema changes or commits were added.
Acceptance criteria are in [backorder-po-routing-spec.md](backorder-po-routing-spec.md).

| Acceptance | Evidence |
| --- | --- |
| Shared SCM panel and active-child dropdown; Sales has no editor | Real Chromium/HTTP integration, existing Special browser regression, Sales page assertion |
| Attach/detach exact child, preserve source/siblings and native identity | Backorder attachment integration, exact database snapshots, existing Special child/document tests |
| Stale, foreign, cancelled, received and planned attachments rejected | HTTP integration; 15 seeded invalid-ID property cases; concurrent attachment returns one 200 and one 409 |
| SCM authorization and Backorder workflow boundary | Anonymous 401, Sales 403, Backorder through Special endpoint 404; existing workflow/context tests |
| Failed drafts retained, retry works, delayed responses cannot replace current PO | Chromium save-conflict and delayed-response/retry scenarios |
| STREQ-000166 remains on whole POB04147 | Live deployment audit: no selected child, both child options present, child references/revisions/schedule statuses unchanged |
| Refresh sees external schedule edits; whole-PO Note uses canonical vendor | Browser refresh regression; SQL-backed routing service with only NetSuite boundary isolated; vendor identity unit test |

Final verification on the current live base: **39 tests passed, zero failed**.
After mutations, the focused suites passed again: **7 passed, zero failed**.
All **5/5** deliberate faults were caught: dropped attachment ID, foreign-child
acceptance, wrong Note vendor, discarded browser selection and stale routing on
refresh. All runtime hashes matched after restoration. Property-only mutation
replay and independent random-order stress were not run; the focused rerun is
the suite-health check.

All nine changed JavaScript files passed syntax checks. Focused routing UI types
and scoped ESLint passed. Node coverage measured **42/42 changed backend lines**
executed. Chromium exercised selection, save, conflict, reload, retry and request
switching; its interval-based report covered 51 of the controller's 78 raw source
lines, including the effect of comments and formatting. This is not exhaustive
browser branch coverage. Full-repository tests, global type checking and a
multi-browser matrix were not run. No dependency audit was needed because the
dependency set did not change. The scoped diff contains no credentials.

Initial regression tests failed before implementation for the absent Backorder
routes, dropped child ID and missing selector. Additional RED cases exposed the
missing canonical vendor and stale panel after Refresh. Test setup corrections
supplied the required plan date, opened both requests for the switching scenario,
and kept the simulated outage active until Retry. Type and verification-script
lint findings were fixed without relaxing assertions or rules.

A concurrent repair release changed the live base during verification. The full
checks were repeated on that newer image. An unfinished concurrent edit in the
shared request repository was excluded by freezing this task's exact patch;
that unrelated workspace work remains intact.

Reproduce on the application host with:

```sh
bash docker/run-backorder-po-routing-checks.sh final
```

The runner applies the saved task patch to the captured live runtime and records
the base image and file hashes. It uses the standard bounded Compose services in
`mbbs-tests.slice`, registers teardown before startup, and removes containers,
disposable database storage, networks, temporary source, coverage and browser
output through the retention wrapper. Final teardown verified `docker ps` and
`docker ps -a`; only the four production containers remained. Retained release
files are scoped source/rollback material and operational audit records.

Toolchain: Node 20.20.2, TypeScript 7.0.2, ESLint 10.8.0, c8 12.0.0,
fast-check 4.9.0 and Playwright 1.62.1. New invalid-ID properties use seed 166;
the existing child-PO properties retain seed 3429.

Deployment audit: `server/deployments/backorder-po-routing-20261029/` contains
the frozen task source, patch, tested input hashes, final result, manifest,
rollback configuration and live verification. Tested base image:
`sha256:4c20b20b2514a7b8e02e6e8bdb35f63751518de7a3843cf8f51c71730ae4e11d`.
Deployed image:
`sha256:6efe15f3279dd9b1e08174d8080cc0dd040e10820185baf3e4a2bac3a4361474`.
Rollback tag: `mbbs-operator-app:rollback-backorder-po-routing-20261029`.
Local/public health returned 200, all seven public asset hashes matched, and
anonymous access to the new endpoint returned 401. App configuration and the
three dependent production containers were preserved.

A final read-only NetSuite check confirmed that POB04147's existing native Note
is readable (107 characters). No remote writes were made by this check; the
operational result is in `live-note-verification.json`.
