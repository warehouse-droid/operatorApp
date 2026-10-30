# SO fulfillment from Operator loading — evidence

Deployed 2026-10-21 at 17:10 UTC after the user explicitly requested deployment.
Operator loading queues IF for the exact loaded lines and quantity increase;
Driver completion remains evidence only. Migration 301 is applied in production.
All four existing yard gates remain enabled with their revisions unchanged.

Operator loading now saves a durable IF candidate in the load transaction. Its
snapshot contains only the increase in loaded quantity, with the original item,
NetSuite line, parent SO, and line location. Driver completions retain their
ordinary evidence and create no IF candidate. Reloads do not create another IF.

Migration 301 removes the Driver enqueue trigger and installs the load trigger.
Untouched legacy automatic candidates become visible Admin attention items and
release their claims; attempted transactions and explicit reviewed work retain
their existing recovery state. New Driver events cannot enter through historical
Admin selection. Existing historical loads are not automatically replayed.

Spec approval: not obtained (autonomous run). The user's clarification is recorded
in [the specification](sales-delivery-load-fulfillment-spec.md); its later clauses
supersede the original proposed Driver fallback. This was a Tier 3 verification.

From the repository root, reproduce the complete scoped checks with:

```sh
sudo -n bash server/tools/sales-delivery-load-test.sh
```

The runner uses the standard bounded Compose services and repository retention
wrapper. It installs only dependencies already pinned in `package-lock.json`
inside its unique disposable artifact directory. There are no dependency or git
commit changes. Source baseline comparison preserves concurrent IF/IR changes in
the shared target resolver, service, and feature catalog.

| Check | Final fresh result |
| --- | --- |
| Full selected fulfillment regressions | 349 passed, 0 failed |
| Reversed file order | 349 passed, 0 failed |
| Coverage run | 349 passed, 0 failed |
| Changed executable JavaScript lines | 137/137 covered |
| Type checking of affected files | 16 baseline diagnostics, 16 current, 0 new |
| ESLint and syntax | 0 issues; all 7 production JS files parse |
| Secret scan | 0 findings in the 7 production JS files |
| Manual mutation | 7/7 faults detected; original sources restored |
| Post-mutation focused verification | 20 passed, 0 failed |
| New generated properties | 150 quantity/identity examples; 25 database load sequences |
| Concurrency | 8 independent database transactions, exactly 1 successful claim |
| Real execution | Actual `recordDeliveryLoad` persisted physical quantity and IF work together |
| Host isolation | Six budget checks passed; Compose teardown removed containers, database and network |

Toolchain: Node v20.20.2, fast-check 4.9.0, TypeScript 7.0.2, ESLint 10.8.0,
c8 12.0.0. The checks print per-file hashes and the source-set SHA-256:
`a0361f40c6c58049e6208fa18dbde27212b715eb112c1ba24c6395373a368a1a`.

| Spec behavior | Verification |
| --- | --- |
| Atomic queue at loading, rollback, exact quantity | Integration `load queues IF…`, `real Operator load…`, `load queue is atomic…` |
| Partial/repeated loading and split parent identity | Integration `partial loads…`, `a split load…`, generated cumulative sequences |
| Original item, line number and yard survive mutable edits | Integration `changed item identity…`, `a changed NetSuite line number or yard…`; hostile-input unit test |
| Gates and one posting owner | Integration gate disable/re-enable and eight-worker claim tests |
| No automatic Driver IF, including direct delivery | Both Driver-evidence-only integration tests; PO/TO evidence migration regressions |
| Reload, pickup, CO, TO and VRMA boundaries | Excluded-family/reload tests and existing pickup/transfer/admission regressions |
| History and Admin visibility | Admin/history integration test; movement-document and gate HTTP suites |
| Legacy attempts and audit evidence retained | Cutover migration test, legacy attention test and existing recovery/ambiguous-post suites |
| Manual IF drift and duplicate-post protection | Existing SO processor and Operator posting regressions, including external-ID recovery |

Mutations inflated quantities, accepted a different item, restored the full-order
line requirement, bypassed a disabled yard gate, removed the legacy non-inventory
skip, reposted cumulative totals, and restored Driver enqueueing. The unit
property suite alone caught the quantity mutant; the remaining guarantees rely
on the example and database tests. The database property also caught cumulative
reposting. This is layered evidence, not a claim that every possible failure was
proved absent.

Initial tests reproduced missing load queue entries and Driver-triggered IFs.
Further checks caught a source-identity drift gap, new implicit type errors and
an excessive-complexity function; these were corrected without relaxing behavior
assertions. The first baseline attempts lacked some local test packages; the
final runs used the pinned dependencies and had zero test failures.

Limits: the unrelated full application suite and browser layouts were not run.
No frontend layout changed. Existing type diagnostics remain. No dependency
audit was needed for a dependency change because none was introduced. Verification
did not exercise live NetSuite posting or backfill historical loads. Historical
queue review remains an operational step.

The production release overlays only the seven JavaScript files and migration
301 onto the captured live image. An unrelated workspace quantity-policy edit
in the target resolver was excluded. The assembled image passed all 349 selected
regressions against a fresh disposable database, imported the server successfully,
and matched all 1,433 expected runtime file hashes. A separate empty disposable
database verified rollback SQL and migration reapplication. Temporary test
resources and logs were removed after each run.

The app owning the SO posting scheduler was stopped for the migration and image
switch. The database, webhook worker, Ollama, app environment, mounts and other
runtime settings were preserved. Two untouched legacy Driver candidates became
Admin attention items with cutover audit entries and no active claims. Existing
attempted transactions retained their recovery state. No historical load
candidates were created during deployment.

Post-deployment checks confirmed migration 301, the enabled Operator-load trigger,
absence of the Driver enqueue trigger, unchanged yard gates, all runtime hashes,
HTTP 200 health locally and at the public application, and HTTP 401 for both
anonymous Admin fulfillment endpoints. Only the four production containers
remain. The previous image, schema and affected queue records are retained for
rollback under the repository deployment retention policy.

Release image: `mbbs-operator-app:sales-delivery-load-20261021`, digest
`sha256:57baff37d063afc685642f6d807d8522aa9ae5a9003f0655eca356fa277e20b6`.
Operational audit: [deployment-result.json](../deployments/sales-delivery-load-20261021/deployment-result.json).
The reproducible release tools are `tools/sales-delivery-load-release.py` and
`tools/sales-delivery-load-release-test.sh`.

After final teardown, both `docker ps` and `docker ps -a` showed only the four
production containers. App, database and Ollama were healthy; the webhook worker
was running. The production health endpoint passed. Disposable logs, coverage,
installed test dependencies and temporary source copies were removed by the
retention wrapper; this concise evidence is the retained test record.
