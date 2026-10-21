# Sales discount and PALLET adjustments — evidence

Spec: [special-workflow-adjustments-spec.md](special-workflow-adjustments-spec.md).
Spec approval: not obtained (autonomous run). Tier 3 because this change affects
order amounts and recoverable remote writes. No production order was modified
for verification. The protected SPREQ-000006 was neither changed nor retried.

The application and webhook worker were deployed on 2026-09-26 using image
`sha256:cf5b4e7e202544c489e750c18fcd6be4e1e47d9758b9fe6ca1e89e2376effb07`.
Migration 233 adds nullable native discount metadata without repricing existing
orders. Both service configurations and the database/Ollama containers were
preserved. Local and public HTTP health returned 200, and all three changed
browser assets matched their verified source hashes over both HTTP paths.
Business-row fingerprints for SPREQ-000006 and SPREQ-000007 were identical before
and after deployment. The previous app and worker images and rollback compose
file are retained in the release directory.

**External step still required:** upload
[`netsuite-smart-scm-picking-ticket-restlet.js`](../netsuite-smart-scm-picking-ticket-restlet.js)
version 3.2.0 to the existing NetSuite script deployment. The final read-only live
health check reports version 3.1.0, with SO/PO PDF capabilities but without
`createSpecialSalesOrder` or `specialOrderAdjustment`. This workspace has no
script-upload connection. New discounted creation checks capability before
submission; new adjustments need the snapshot action before any remote write.
The new native write behavior was tested against the actual SuiteScript source
with a simulated NetSuite record boundary, not by modifying production orders.

| Requirement | Executed verification |
| --- | --- |
| Editable discount and whole PALLET count; fixed original rate; SCM review; no manual refresh | Sales and SCM browser scenarios at 1440, 1024 and 390px, authenticated HTTP and real PostgreSQL review tests |
| Gross MBBS-Special line followed immediately by Custom Discount% with a negative percentage; zero omitted | Payload contracts, decimal properties, actual RESTlet VM execution and native transport contract |
| Discount and PALLET proposals do not alter issued values before SCM approval | Repository/service integration, rejection, stale revision, authorization and concurrent reviewer tests |
| Preserve PO costs, material identities, native links, descriptions and UOM | Complete before/after adapter contracts and RESTlet insert/remove tests |
| Add, change and remove PALLET; preserve recorded rate | Real local approval tests, native record add/remove tests and browser submission checks |
| Retry after lost response or partial SO/PO success without duplicates | Durable journal/service tests, actual RESTlet execution, complete-record conflict properties and JSONB key-order regression |
| Accept only authorized webhook transitions and invalidate saved previews | Real PostgreSQL early-webhook/lost-response scenario and native PDF snapshot assertions |
| Legacy issued net-rate orders remain unchanged; unsubmitted discounted drafts upgrade safely | Dedicated issued/submitted/unsubmitted fixtures and additive migration tests |
| Preserve closure, native PO, local quote, role privacy and Dispatch guards | Related Special Item suite, including real plan/closure locking and HTTP contracts |

Final verification: **254/254 related tests pass**, plus the existing RESTlet
harness and **six browser role/viewport scenarios**. The 95 focused checks also
pass with their file order reversed. Strict JavaScript type checks cover the new
pricing and durable adjustment domain; scoped ESLint and runtime syntax checks
pass. The secret scan passes. No runtime dependency was added.

Coverage measures **480/480 changed executable lines** and **362/444 measured
changed-line branches**. Five deliberate mutants are killed by the contract
suite, and all five are independently killed by property-only runs. These
mutants cover corrupted gross price, a reversed discount sign, discount inserted
before its material, ignored unrelated order edits, and lost percentage text.
This is scoped manual mutation evidence, not an exhaustive mutation score.

RED checks exposed the original missing discount/PALLET review, reduced native
material pricing, half-cent rounding differences, a PALLET description mismatch
during webhook reconciliation, and JSONB key-order sensitivity during retry.
Those defects were corrected before the final clean run. Legacy tests that
asserted a net-rate draft were changed only to reflect the explicitly requested
separate discount line; issued legacy fixtures retain their old representation.
A browser refresh assertion was corrected to wait for the new rendered detail
before checking removed controls. No acceptance criterion was weakened.

Separate line rounding uses rounded gross cents minus rounded discount cents;
for example, 0.01 at 50% produces 0.01 gross and -0.01 discount. PO prices and
PALLET prices are not discounted. Percentage values retain four-decimal
precision. The legacy embedded-rate helper remains for existing issued orders.

Reproduce the isolated verification from the repository root:

```bash
bash server/tools/special-workflow-adjustments-gauntlet.sh
```

This uses the existing disposable `mbbs-special-review-runner` and
`mbbs-special-review-db`, their migrated review database (through migration 233),
the browser test server and installed Chromium. Tool versions: Node v20.20.2,
TypeScript 7.0.2, ESLint 10.8.0, c8 12.0.0 and fast-check 4.9.0. Broad unrelated
Dispatch regression was not rerun for this change.

Raw test, browser, mutation and coverage evidence, source hashes, screenshots and
the runtime diff against the captured deployed baseline are under
`server/test-artifacts/special-workflow-review/adjustments/`.
Source manifest SHA-256 (compact JSON serialization):
`6cbfa7581dae553af0a56b0597e4ad27d79a4629081f991db5053f2a66e83be4`.
Deployment/configuration checks, migration result, protected business hashes,
public asset verification, RESTlet health and rollback files are under
`server/test-artifacts/special-workflow-adjustments-release-20260926/`.
Private resolved compose configuration stays protected and is not reproduced
here. No commit was made in the shared dirty workspace.

Read-only deployment verification:

```bash
python3 server/tools/special-workflow-adjustments-deploy.py verify
```

The initial host-side public HTTPS probe returned 403; the subsequent checks
from the app container returned 200 for the public and local routes with exact
hashes. An initial RESTlet probe exceeded its subprocess deadline; the bounded
retry with explicit process completion returned the 3.1.0 health result above.
Neither probe changed an order.

Limits: the application cannot atomically lock both external NetSuite orders
against other users' edits. Complete pre/post comparisons and the saved review
detect conflicting states and retain recovery information. NetSuite account
write behavior and permissions for the new actions remain to be confirmed after
uploading RESTlet 3.2.0. No live discount or PALLET amount was selected or applied
to SPREQ-000007 during this work.

Account read-only checks found active Custom Discount% item 10716 and numeric
REST rate metadata. The implementation uses SuiteScript percentage text and
in-place row insertion. Supporting Oracle documentation:
[line discounts](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_160312998983.html),
[discount item and tax behavior](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_N2248474.html),
[insertLine](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_4273158210.html),
and [setSublistText](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_4273167591.html).
