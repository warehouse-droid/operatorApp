# SN1400625 deleted parent-line validation

Tier 3: PO line identity controls inventory receipts.
Spec approval: not obtained (autonomous run under the reported receiving failure).

## Observed defect

SN1400625 / -81664606940713 belongs to POB03669 / 939701. The split ledger
contains keys 4737066, 4851526, 4851527, and 4851536. Parent key 4851525 is
not in this split; its retained row is inactive with sync_exception=line_deleted.
The real-source resolver queries every inventory parent row, including this
deleted history, and rejects it before creating a receipt command.

## Acceptance criteria

1. An inactive PO parent row absent from live NetSuite does not block an active
   split. The incident's selected keys still resolve to REST lines 1, 24, 25;
   receipt quantities remain 360, 360, 288 and memo SN1400625. The unconfirmed
   PALLET line 34 and every other open line remain deselected.
2. Only explicitly inactive parent rows are excluded. An active parent line
   missing from live evidence still fails with LINE_MAPPING_UNRESOLVED.
   Closed or completed rows do not become inactive merely because of progress.
3. A selected split line whose source parent is inactive still fails its active
   ledger/source mapping. An inactive unrelated source cannot lend its identity
   to a selected line. Missing or ambiguous live identities still fail closed.
4. PO orders without a split follow the same active-source filter. Source order,
   local child IDs, quantity, location and nonsequential REST identities remain
   unchanged. A different PO's inactive lines do not affect this PO.
5. Generated SQL-backed cases verify both successful active selections with
   arbitrary retired history and rejection when any required active key is
   missing. Existing SO/TO, receipt draft, admission, idempotency and posting
   tests remain unchanged and must introduce no new failures.

## Failure model and setup

An overly broad filter could omit required active validation or accept an
inactive source; SQL integration cases, two-sided properties and deliberate
mutants exercise these boundaries. Wrong quantities/source identities are
checked through the actual target resolver and receipt draft. Real execution
uses a read-only production replay; no receipt, fulfillment or posting retry is
performed as a test. Concurrent NetSuite changes remain outside an atomic read.

Use existing Node 20, PostgreSQL, fast-check, c8, TypeScript and ESLint Docker
tooling. Add no dependencies or migrations. Keep production data unchanged.
Preserve pre-existing work and isolate baseline/candidate snapshots under
test-artifacts/sn1400625-receiving. Runtime edits are limited to the PO query in
operator-netsuite-posting-targets.js. Record baseline/full regressions, static
checks, changed-line coverage, focused shuffled tests, mutation results and the
read-only incident replay. No commits or production deployment in this spec.
