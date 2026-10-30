# Backorder Add item — verification evidence

[Specification](backorder-add-items-spec.md). Spec approval: not obtained
(autonomous run). The user approved deploying Add item and explicitly identified
Backorder as missing from that feature.

The release adds the shared purple button below Backorder materials, uses the
existing Backorder material selector and vendor/destination fields, and resets
successful additions to `new_enquiry`, displayed as **Pending SCM**. Existing
material identities, prices, stock reviews, Sales decisions and header details
remain saved. A single transaction appends materials, clears superseded
request-level review markers, records their prior values, and advances revision.

Reproduce the complete scoped verification:

```sh
bash docker/run-backorder-add-items-checks.sh
```

The initial HTTP regression failed before implementation because the Backorder
items action was unavailable (409). Subsequent fixture fixes used the existing
native-unit input contract and local price-edit API, valid manual-order metadata,
and dismissed the app's normal notification modal before interaction. Assertions
still require successful append, exact old-line preservation, and initial status.
The displayed-status assertion was explicitly clarified in the specification.

Independent baseline verification ran the unchanged captured live image
`mbbs-operator-app:repair-office-merge-20261027`: 46 of 52 tests passed, with six
existing failures. Five Backorder assertions concern older notification payloads
or SO-link acceptance; one Special Order assertion expects `confirmed` before
its add-items action, but the fixture is already `await_customer_confirmation`.
No baseline assertion was changed. See the
[concise baseline record](../tools/backorder-add-items-baseline.json), reproducible
with `bash docker/run-backorder-add-items-baseline.sh`.

New integration tests cover actual HTTP/database writes, preserved priced SQL
rows, pending information, role/yard/revision restrictions, native UOM, invalid
materials, a combined 100-line limit, duplicate concurrent submits, linked orders,
closed/completed cases, Already Ordered material preservation, and transaction
rollback after an injected second-insert failure. Browser tests exercise 1440px
and 390px widths, the existing purple styling, Cancel/Escape, adding/removing
rows, vendor/note preservation and retrying failed saves. Generated properties
exercise both permitted and prohibited cases; mutation checks target that policy.

Limits: verification is scoped to relevant workflows; unrelated repository suites
are not run. No live records or external NetSuite orders are created by tests.
No dependencies or schema changes are required. Policy mutations cover eligibility;
SQL atomicity is exercised separately through real database transactions.

Every test run uses the bounded disposable Compose runner and unique temporary
artifact directory. Teardown removes test containers, database storage and
networks; the outer runner deletes raw logs and generated artifacts, including on
failure. The final operational audit records production health and cleanup.

Final validation: 2026-10-27T19:59:00.553Z.

| Check | Result |
| --- | --- |
| Relevant regression suites | 119 tests across 15 files: 113 passed, 6 independently reproduced baseline failures, 0 new failures |
| New scenarios repeated in reverse file order | 10/10 passed |
| Changed JavaScript coverage | 73/73 measured lines; 65/67 branches |
| Manual eligibility mutations | 5/5 detected by the generated property suite |
| Generated eligibility cases | 200 per property run |
| Static checks | 5 JavaScript files; no new type, lint, complexity or secret findings |

Deployed at 2026-10-27T19:59:36Z as `mbbs-operator-app:backorder-add-items-20261027`.
All six runtime files match the tested candidate; all four changed public files
match through HTTP. Production health passes, the application configuration and
other three production services are preserved, and a rollback image is retained.
No schema migration was needed. Both running and stopped container inventories
show only the four production containers; all five test projects have no remaining
containers, volumes or networks.

[Validation](../deployments/backorder-add-items-20261027/validation.json) ·
[Scoped release patch](../deployments/backorder-add-items-20261027/release.patch) ·
[Deployment](../deployments/backorder-add-items-20261027/deployment.json) ·
[HTTP verification and cleanup](../deployments/backorder-add-items-20261027/http-verification.json).
