# Operator receiving identity (SN1400409)

Spec approval: not obtained (autonomous run). Tier 3 because the correction
touches the existing yard authorization check.

## Observed failure

Read-only production execution found SN1400409, an active Unilock split of
POB03658, stored as purchase order -49090675180799 for yard 3445 (location 1).
The receiving list and detail repository return its two lines. The yard guard
instead classifies every negative ID as a local CO, whose lookup returns null,
and throws HTTP 404, `Operator record not found.`

## Acceptance criteria

1. Opening this negative purchase-order ID, with or without the purchase-order
   type, returns SN1400409 and its two lines to an operator assigned to yard 1.
2. Negative transfer-order IDs and ordinary positive purchase IDs also resolve
   from the canonical receiving repository and use their destination yard.
3. Confirming and unconfirming a split PO line works for its assigned operator.
   A different yard cannot read, refresh, confirm, unconfirm, or receive it.
4. Receiving photo and in-memory receipt-job authorization resolve the same
   negative purchase-order identity and retain the destination-yard check.
5. Explicit local CO types and CO references retain their local lookup. A
   negative ID without a canonical receiving order retains the legacy CO fallback.
6. When canonical and local records share an ID, an ordinary receiving request
   authorizes the canonical order. An explicit CO request authorizes the CO.
   Caller-supplied yard values cannot override either record's actual yard.
7. Missing records retain HTTP 404. The guard still includes closed NetSuite
   records so existing downstream editability rules decide whether work is allowed.
8. Generated combinations of signed IDs, order families, lookup modes and yard
   grants resolve exactly the intended stored record, allowing precisely its yard.

## Failure model and verification

- Wrong identity or fail-closed regression: realistic HTTP reproduction and
  database-backed identity/property tests, with mutants restoring the old bug.
- Cross-yard access or ID collision: denied HTTP mutations, photo/job checks,
  adversarial duplicate-ID fixtures, and two-sided generated authorization checks.
- Broken local CO or closed-record behavior: explicit regression cases and mutants.
- Unrelated regressions: compare full tests and static checks to captured pre-fix
  source; preserve all other working-tree changes.

## Setup and boundaries

Use installed Docker test image mbbs-retired-confirm-test:20260914 (Node 20),
its existing PostgreSQL/Node test, ESLint, TypeScript, c8 and fast-check tooling.
Add this spec, a focused integration test, a reproducible gauntlet and evidence
under test/ and tools/; write generated reports under test-artifacts/.
Use a disposable internal Docker network and database. No dependencies, schema
changes, commits, production writes, NetSuite transactions or deployment.
Only receiving identity selection in operator-yard-authorization.js will change;
the existing yard decision, receipt processing and public API remain intact.

## Additional observation: search result with an empty detail panel

The user also reports finding SN1400409 but seeing no lines. Reproduce the actual
Operator page with a successful list response followed by the observed detail
404, then a successful detail response containing the current two item lines.
Verify that the first response leaves no line cards and the corrected response
renders both receivable lines. Use existing Chromium tooling with simulated HTTP
boundaries; no frontend production change or live receipt is part of this check.

Browser observation: after an initial failed search, the page can retain its
previous screen until another UI action renders the stored search results.
The before-fix browser scenario therefore includes a language toggle, a normal
rendering action, before asserting that the found order has an empty detail.
The corrected response must show both lines immediately without this extra action.

## User-requested audit of all split POs

Search every existing dispatch_scm_po_splits record against one read-only database
snapshot. For receiving-eligible records, compare the deployed and prepared guard,
typed and untyped PO requests, destination-yard authorization and actual deployed
UI line filters. Classify cancelled and non-receiving statuses separately. Explain
empty details from stored allocations without changing allocations or receiving
anything. Persist all record-level outcomes and any separate data inconsistencies.

## User correction: allocated goods still require an Item Receipt

The user clarified that fully allocated PO lines must remain visible and receivable.
This supersedes the earlier identity-only scope and acceptance of allocation-based
empty details. SO allocation reserves goods; it does not mean goods were received.

9. A PO with quantity 1234, all allocated, displays and confirms all 1234. All
   original PLT/LYR/SEC/PCS quantities remain available before any receipt.
10. Receiving availability equals ordered quantity minus the NetSuite received
    baseline, regardless of partial, full, or excessive SO allocations. The UI
    consumes the projected remaining quantity without subtracting receipts again.
11. An overallocated 1140 PC / 19 EACH split displays and receipts at most 1140 /
    19, even if allocations are 1320 / 22. Allocation records remain unchanged.
12. Fully received lines cannot generate another normal receipt. Confirmed
    physical/native quantities and IR payload quantities remain bounded by the
    remaining PO quantity. Generated quantities exercise both upper and lower
    bounds, including zero remaining, decimal sales units and all physical units.
13. A negative split PO resolves through the active PO split ledger to its positive
    NetSuite parent, retaining PO/IR type, destination and exact source line. A
    child with a synthetic line key uses ledger lineage. Missing/cancelled lineage
    fails closed. Existing SO, TO, local CO and posting reconciliation behavior stays.
14. Re-run all split searches with the prepared authorization, receiving projection
    and UI. Previously fully allocated empty orders must show unreceived lines.

Additional failure model: wrong units or double receipt (quantity/property tests,
existing posting reconciliation tests); incorrect parent or line (real database
lineage with mocked remote read boundary); stale browser assets (versioned script
and service-worker cache tests); allocation damage (before/after stored snapshots).
The setup remains dependency-free and isolated. Runtime scope now also includes
receiving projection, UI remaining-quantity handling, PO posting lineage and cache
versions. No production writes, real receipts, service restarts or deployment.
