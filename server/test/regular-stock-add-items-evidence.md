# Regular stock Add item — verification evidence

[Specification](regular-stock-add-items-spec.md). Spec approval: not obtained
(autonomous run). Tier 3 checks address atomic status resets and concurrent writes.

Deployed at 2026-10-27T19:25:20Z as `mbbs-operator-app:regular-stock-add-items-20261027` after explicit user approval. All eight runtime files match the verified candidate; all six public files were checked through HTTP. Production health passes, application configuration and the other production services are preserved. No schema migration was needed. A rollback image is retained.

Run the complete scoped verification from the repository root:

```sh
bash docker/run-regular-stock-add-items-checks.sh
```

Final fresh run: 2026-10-27T19:23:19.673Z.

| Check | Result |
| --- | --- |
| Relevant regression suites | 112 tests across 14 files: 111 passed, 1 independently reproduced pre-existing failure, 0 new failures |
| New scenarios repeated in reverse file order | 12/12 passed |
| Changed JavaScript coverage | 121/121 measured lines; 100/103 branches |
| Manual mutations of shared eligibility/reset policy | 5/5 detected by the property suite |
| Property inputs | 200 eligibility cases and 200 preservation/reset cases per run |
| Static checks | 6 JavaScript files: no new lint, type, complexity, or secret-scan findings |
| Dependencies and schema | No changes |

The new [integration tests](mbt/integration/regular-stock-add-items.test.js) cover
preserving existing item/header/stock data, resetting approvals and waiting markers,
Purchase and Transfer requests, role and yard restrictions, invalid input, revision
conflicts, the 100-item limit, combined availability, concurrent SCM decisions,
transaction rollback, stored downstream commitments, and audit history. Real browser
checks cover desktop and mobile, the matching purple button, Cancel/Escape,
adding/removing lines, and retrying a failed save without losing input. The shared
[properties](mbt/property/regular-stock-add-items.property.test.js) check both allowed
and blocked requests and preservation without mutation.

The unchanged live source reproduces the single older Special Order failure:
`HTTP add items resets New enquiry, preserves every old SQL column and invalidates
the unsent SO draft` expects `confirmed`, but its fixture is currently
`await_customer_confirmation` before it attempts to add items. The assertion was
not altered. Reproduce with `bash docker/run-regular-stock-add-items-baseline.sh`;
its concise record is [stored here](../tools/regular-stock-add-items-baseline.json).

Development checks first failed for the missing feature, then exposed the combined
availability gap, which was fixed. Harness corrections preserved assertions: modal
Escape timing, a prototype-preserving generated-data snapshot, required transfer
actor/reference values, and the older suite's isolated hostname/inventory fixture.

Limits: the repository-wide unrelated suites were not run. Type checking follows
existing JavaScript annotations. Browser availability refresh uses the cached test
inventory boundary; no production or external NetSuite writes were exercised.
SO-based Delivery, single-item Waitlist, Backorder, and already processed requests
retain their existing workflows. The property mutations cover the shared policy;
SQL atomicity is checked separately through actual transactions and injected failure.

All test runs used the bounded disposable Compose runner and unique artifact
folders. Each run removed its containers, database storage, networks, and raw
outputs, including on failure, and checked production health. Independently running
Repair tests were observed on the shared host and were not interrupted.

Source fingerprint (sorted scoped SHA-256 map): `fb84dc187c1d47b1153280fe11d39bff1287e0fb0c2c20289bff9b917d81efbc`.
The [validation record](../deployments/regular-stock-add-items-20261027/validation.json)
contains individual hashes and tool versions; the
[release patch](../deployments/regular-stock-add-items-20261027/release.patch)
contains only this feature's changes over the captured live application.

[Deployment record](../deployments/regular-stock-add-items-20261027/deployment.json) · [HTTP and cleanup audit](../deployments/regular-stock-add-items-20261027/http-verification.json).

Follow-up: Backorder is now included; see [Backorder Add item verification](backorder-add-items-evidence.md).
