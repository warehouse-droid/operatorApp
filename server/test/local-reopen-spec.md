# Local reopening across Dispatch and Operator

User extension: reopening must make an order Open locally in both Dispatch and
Operator even while NetSuite says Billed. Autonomous run; spec approval not
obtained. Tier 3. Preserve the already linked SOM06964 PO allocations.

1. An authorized Control reopen of an unfulfilled Billed sales order records its
   existing immutable audit and opens Operator delivery prep and customer pickup.
   An open header alone, without that audited reopen, does not bypass Billed gates.
2. Dispatch treats an audited reopened order as local work, displays its local
   status, permits its usual planning/link actions, and retains it when a plan is
   saved or refreshed. Current server authority replaces stale client flags.
3. Ordinary NetSuite Billed refresh/calculation cannot close or hide that locally
   reopened work or remove its saved Operator entry. NetSuite status and billing
   facts remain intact. Actual fulfillment progress or a Closed/inactive order
   still overrides the local exception.
4. Preparing, confirming and packing remain available through existing guarded
   APIs. Loading or actual fulfillment ends the open-work exception. Existing
   roles, yard restrictions, posting claims, quantities, photos and audit survive.
5. Exact order identities govern the exception, including groups and splits;
   reopening one order never opens an unrelated Billed order. Service outages,
   stale snapshots and a forged browser flag cannot create reopen authority.

Failure model: financial/status corruption (before/after conservation), stale
authority (adversarial lifecycle matrix and real API tests), lost saved/planned
work (refresh/reconciliation tests), authorization bypass (existing HTTP suite),
concurrent work (existing locking tests plus runtime predicate recheck), and
release drift (current source capture, narrow file overlay, rollback artifacts).

Setup uses the existing toolchain, no new dependencies, no schema migration, and
no git reset or commits in the shared dirty workspace. Tests use standard bounded
isolated Compose in mbbs-tests.slice with teardown registered before startup;
remove containers/volumes/networks and verify production health and both ps lists.
Retain logs, baseline diagnostics, changed-line coverage and manual mutation
evidence. Full relevant suites are the regression boundary; unrelated app suites
are outside this change. Live order corrections are operational work, never tests.

Schema correction after the first green attempt: Sales Order lines store synced
NetSuite shipped progress in loaded_qty, not in the PO/TO-only
netsuite_received_qty column. The lifecycle matrix uses the actual loaded and
fulfilled quantity fields; the authoritative NetSuite snapshot test separately
checks cumulativeProgressQuantity. No quantity safeguard is removed.
