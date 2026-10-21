# Special order REST writes — evidence, 2026-09-26

Spec: [special-workflow-rest-orders-spec.md](special-workflow-rest-orders-spec.md).
Spec approval: not obtained (autonomous run). The user authorized SOB121380 testing,
required standard REST order writes, and then explicitly allowed calculated
currency discounts when REST rejected percentage text. SPREQ-000006 was excluded.
This report supersedes the earlier RESTlet order-write deployment requirement;
the existing RESTlet remains responsible for NetSuite PDF previews.

## Deployed behavior

SO creation and reviewed SO/PO adjustments use the NetSuite REST Record API.
Each selected material discount becomes a Custom Discount% item 10716 directly
after its MBBS-Special Order item 2055, with Custom pricing and a negative numeric
amount. The local selected percentage remains available for recalculation after
quantity or discount changes. PALLET and vendor costs are not discounted.

The application and webhook worker now run image
`sha256:672c3a331776f57413bf13eeb8652b98c163596b4ad483ef9389abf763d6c8f6`.
Only seven runtime files were overlaid onto the previous deployed image. Service
configuration and dependencies were preserved; no migration or script upload was
required. Deployment health, exact file hashes and protected business fingerprints
passed. The previous image and rollback compose file are retained privately in
`server/test-artifacts/special-workflow-rest-orders-release-20260926/`.

## Verified live results

- **SPREQ-000007 / SOB121380, internal ID 1017068:** saved through REST and reread
  from NetSuite. Material is 50 × 20 = 1000, immediately followed by Custom
  Discount% at **-150**, then PALLET 11 × 40 = 440. Pretax amount remains 1290;
  final order total remains **1457.70**. The material key 5028178 was retained.
  The unlinked PALLET was recreated after the discount and its new key 5028785
  was verified and mapped locally. POB03934 and its complete saved snapshot were
  unchanged. The local review is approved, with gross material rate 20 and
  selected discount 15%. Both role-specific SO preview requests returned actual
  NetSuite PDFs, archived privately with the correction checkpoint and result.
  After webhook synchronization, a second complete order verification passed.
  Both Sales and SCM then returned `cached: true` for the 36,365-byte SO PDF with
  the external PDF fetch deliberately blocked, proving reuse of the saved file.
- **SPREQ-000009:** fresh marker and external-ID reads found no existing order.
  The exact failed operation was rearmed once with a durable audit event and
  unique external ID `MBBS-SPECIAL-SO:64`. The real creation service used REST and
  created **SOB121381, internal ID 1017268**, Pending Fulfillment. Saved order
  lines are material 5 × 10 = 50, discount **-7.50**, and PALLET 5 × 40 = 200,
  in that order. Total is **274.03**. Exactly one marker match was found and the
  order was linked locally. No PO was created by this recovery operation.
- **SPREQ-000006:** protected business fingerprints matched before and after
  deployment and both corrections. It was neither modified nor retried.

Operational evidence and checkpoints are in the ignored, private directory
`server/test-artifacts/special-workflow-review/rest-orders/live/`. No credentials
or private resolved configuration are reproduced in this report.

## Executed checks

The final isolated run passed **272/272 related tests**, JavaScript type checks,
scoped lint, runtime and operational syntax checks, reversed focused test order,
and secret scanning. Changed executable-line coverage is **266/266**; measured
changed-line branches are **226/246**. Five deliberately introduced faults were
each killed by the contract suite and independently by property-only tests.
These are scoped manual mutation checks, not an exhaustive mutation score.

Contracts and real PostgreSQL tests cover amount rounding, zero discounts,
discount adjacency, Custom prices, quantity recalculation, PALLET key remapping,
native link preservation, pending/executed/closed guards, complete saved-plan
validation, stale edits, lost responses, partial SO/PO success and idempotent
retry. Transport tests call the actual wrappers and fail if an order RESTlet
action is used. Existing related tests retain role permissions, PDF caching,
SCM review, local quote, Dispatch and closure coverage.

Live capability probes established that REST rejects `rate: "-15%"` even with
Custom price. Numeric `-15` is a currency amount, and keyed REST replacements
retain old line positions. Each probe restored and independently verified the
original order before the permanent user-authorized correction. Private probe
evidence is under `server/test-artifacts/special-workflow-review/rest-percent/`.

RED checks exposed the original amount/ordering behavior, missing local PALLET
remapping, and PO REST records without `lineUniqueKey`. PO stable keys are now
cross-checked through SuiteQL using the REST line ID and item. The reversed suite
also reproduced an existing PDF test-decoder defect: a compressed checksum ending
in 0x0d was mistakenly consumed as the newline before `endstream`. A fixed fixture
and declared-stream-length decoding resolve that test-only defect. Percentage
payload expectations were updated only for the user's explicit amount fallback;
legacy RESTlet protocol fixtures remain separate from the production transport.

Reproduce with `bash server/tools/special-workflow-rest-orders-check.sh` using the
existing isolated review runner/database. Tool versions: Node 20.20.2, TypeScript
7.0.2, ESLint 10.8.0, c8 12.0.0, fast-check 4.9.0. No dependency was added. Browser
scenarios were not repeated because this release has no UI change. Unrelated
Dispatch regression was not rerun. Raw logs, baseline, diff and manifests are in
`server/test-artifacts/special-workflow-review/rest-orders/`.

Final checked source-manifest hash:
`9dd387987a56a249196db61b0297e0dfcb99f70d391c25686854d9d043164991`.

## Limits

NetSuite does not expose an atomic lock across the two remote orders. Complete
before/after comparisons and the durable review journal detect conflicts and
support recovery. Existing uncertain submissions are not generally made retryable.
Only the exact failed SPREQ-000009 operation received the bounded recovery.

Adding a new discount before a later existing material is rejected before any
write because the tested REST replacement cannot reposition that material while
preserving its key. New SOs receive the correct full line order, existing adjacent
discounts can be updated/removed, and an unlinked trailing PALLET can be recreated
without changing its reviewed values. No linked material is recreated to insert
a discount. The untouched local RESTlet artifact is outside this release.
