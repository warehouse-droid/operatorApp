# SO location and non-stock line correction

Scope: the reported SOB121631 header error, followed by the user's explicit PALLET, discount, subtotal and delivery-fee clarifications. [Specification](regular-stock-header-spec.md). Tier 3 under the [old-coder skill](/home/ubuntu/.codex/skills/old-coder/SKILL.md). Initial bug-fix spec approval was not separately obtained (autonomous run); the user explicitly supplied the line-type requirements during implementation.

## Findings and behavior

The live read of SOB121631 returned no `transaction.location`, while its main transaction line and REST header both identified location 1 (3445). The adapter now reads the main-line location and retains the header/customer race checks.

The authorized database survey identified Inventory Part, Kit, Non-Inventory Part, Other Charge, Service, Discount, Subtotal and Markup lines. PALLET is an Inventory Part. The built-in subtotal is item -2, has no item-master row, and generally has no quantity; discounts generally have no quantity either. An inner item join omitted subtotal entirely. The corrected LEFT JOIN retains it, handles its special identity and normalizes absent non-stock quantities so persisted retries compare consistently.

Inventory/assembly/kit lines determine routing, except PALLET. PALLET and the observed non-stock types do not force a TO. They follow a complete single-source location change through keyed line updates; quantity, price, item identity and row order are not sent in that update. Unknown item types fail closed. Extra stock still requires the transfer route. The SO ordering header remains its original Sales yard.

Only `src/regular-stock-netsuite-adapter.js` changed in production. No dependency, schema, UI asset, worker configuration or inventory policy change was needed.

## Final fresh evidence

Runtime adapter SHA-256: `4a9fcc78bd95865871f182da7bad6ae5b423235082152c3da72f7f5c291700a4`.

Reproduce with the existing pinned regular-stock Docker test tools:

```sh
python3 server/tools/regular-stock-header-check.py
```

The entry point creates a fresh internal-network PostgreSQL database in tmpfs, runs the tests without production credentials, saves results, and removes that disposable database/network afterward. Existing Node 20.20.2, PostgreSQL 18, c8 12.0.0, ESLint 10.8.0, TypeScript 7.0.2 and fast-check 4.9.0 tools are reused. Baseline hashes and the task patch are persisted in the repository; no checkpoint commit was created.

| Layer | Final result |
| --- | --- |
| Full relevant regular/legacy stock-request and neighboring SCM regressions | **161 passed, zero new failures**; one known missing-item-master fixture harness failure |
| Focused adapter/header/routing/handoff suites | **44 passed** |
| Same focused files in reverse order | **44 passed** |
| Changed runtime lines | **17/17 covered** |
| Entire adapter coverage | **100% statements, lines and functions; 95.34% branches**; repository coverage thresholds pass |
| New generated scenarios | **300 cases** per normal run, seeds 121631 and 121632; existing domain properties also pass |
| Manual mutations | **6/6 killed** by the regressions and **6/6 by the property cases alone**; restored source passes |
| Static checks | Runtime syntax, focused test/tool lint and existing strict domain/parser type checks pass |
| Dependencies/secrets/capabilities | Package hash unchanged; runtime patch contains only query/classification/verification changes, no new credentials or network/file/process/environment capability |

Tests execute the actual adapter SELECT against PostgreSQL fixtures, replacing only Oracle's NVL spelling with COALESCE. They do not replace the join or header-projection logic. Full HTTP/adapter/mirroring/TO integration tests continue to intercept only the external transport. Mutation operators cover the wrong header source, removed location race protection, PALLET counted as stock, companions left at the old yard, lost absent-quantity normalization and subtotal dropped by an inner join.

| Acceptance | Executable evidence |
| --- | --- |
| Missing/stale transaction-body location; same-order main-line identity; true customer/location mismatch | `regular-stock-header.test.js`, including generated SQL/REST mismatches |
| Built-in subtotal without a master item or quantity | SQL subtotal regression and header properties |
| PALLET ignored for stock matching and included in the move | `regular-stock-ancillary.test.js`; PALLET mutation |
| Discount absent quantities, preserved rates, persisted retry | Discount regressions and ancillary properties |
| Discount rate changed after linking blocks writes | Explicit adversarial regression requiring zero PATCH calls |
| Subtotal, fees, services, non-inventory and markup follow stock; unknown types rejected | Type-specific and generated ancillary tests |
| Delivery fee quantity/rate preserved | Explicit Delivery Fee item 3013 regression |
| Extra material still requires TO; quantity/customer/location safety retained | Existing domain, external-workflow and handoff suites plus generated ancillary cases |

## Deployment and live evidence

See [the release record](../deployments/regular-stock-line-routing-20260929/README.md). The image overlays one file and verifies all 1,132 source/assets/migration files against the captured live tree. Environment, mounts, commands, ports and restart settings are preserved; the worker, database and Ollama are unchanged. Previous image IDs and a rollback override are retained.

Actual NetSuite reads verified SOB121631 as two material lines plus PALLET, and SOM06738 with a built-in subtotal and pricing lines. SOB121627 confirmed the subtotal representation through SuiteQL, but NetSuite refused its REST GET because a workflow locked that order; the lock was respected.

During final live verification, SOB121631's item 9736 changed from 760 EACH to 912 EACH while STREQ-000059 still approved 760. The quantity guard correctly rejected the link. The first deployment attempt automatically reverted because its verification expected the original quantities. The release check was corrected to report this legitimate data mismatch separately while retaining the exact runtime quantity guard; the same verified image was redeployed. No order quantity or location was altered by these probes. The user confirmed this was an intentional edge-case test and requested a precise rejection; see the [confirmation and quantity-message follow-up](regular-stock-confirmation-evidence.md).

Raw evidence lives in `test-artifacts/regular-stock-header/`: RED TAP, final TAP/coverage, property/mutation results, fresh-database layer results and the line-type survey. Release files retain live read snapshots, the current preview outcome and public health evidence.

## Limits and investigation notes

- No live SO, TO or PO write was used to test this change. Account-specific update permissions and downstream workflow side effects remain subject to NetSuite's live controls.
- UI/browser checks were not repeated because no UI code changed. The existing release's browser evidence remains applicable; the server's real HTTP boundary is covered here.
- Strict type checks cover the existing typed domain/parser core, not the untyped adapter. The adapter has syntax, lint, SQL, property and integration checks.
- No performance SLA was supplied. Read-only live checks waited behind the shared NetSuite background queue; its limits were not changed.
- The first SQL fixture omitted `transaction.type`; that fixture was corrected before capturing the actual header-error RED. A first coverage run also inherited the MBT branch threshold for the broader adapter; the final expanded suites cover 95.34% and pass with coverage enforcement enabled.
- The preserved neighboring SCM harness failure is `Expected active item_master input.` The disposable database intentionally has no uploaded production item-master fixture. No failing assertion was weakened or skipped.
