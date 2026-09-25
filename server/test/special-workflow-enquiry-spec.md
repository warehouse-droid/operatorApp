# Special enquiry corrections — 25 September 2026

Spec approval: not obtained (autonomous follow-up under existing implementation/deployment authorization).
No packages, commits, broad customer-master imports or live NetSuite order writes.

## Acceptance and failure model

1. Search the full active NetSuite directory as well as the canonical import. The
   reported 600020 Action Home Services (internal ID 7988) is selectable by account
   number or name. Preserve distinct accounts with the same business name and
   deduplicate only identical IDs. Explicitly inactive canonical accounts stay
   excluded. SQL input is parameterized and the result limit bounded.
2. Directory-only customers can create enquiries, save SO drafts and supply the
   correct NetSuite entity ID, without fabricated canonical customer data. Retain
   the existing canonical foreign key and use a separate validated directory ID.
   New migration is additive, idempotent and rollback-rehearsed. Authoritative
   customer names are read server-side; unauthorized yards/unknown IDs still fail.
3. Remove the enquiry Brand input. Header vendor provides the brand for new lines.
4. Enquiry requested dates have no three-business-day lead time; reject past dates.
   Explain that delivery requires at least three working days after SO placement.
   The existing Toronto/Ontario holiday minimum is enforced when creating SO.
5. Initial customer decision offers confirm/wait or decline; no Request update.
   Quantity changes in the SO draft continue to trigger the existing SCM review.
6. Remove the PC-per-unit input and default new SO drafts to conversion 1. Preserve
   conversions already stored on older drafts/orders so they are not silently
   repriced. Packaging UOM, locked base rate, line discounts/subtotals remain.
7. Every SO draft edit disables Create in NetSuite and Skip SO creation: text,
   selectors, customer selection, ancillary add/remove/selection, source choice,
   media. Saving re-enables only after success and required SCM quantity approval.
   Failed saves retain edited fields and disabled actions. Add a click guard as
   well as disabled buttons; errors must not reset the dirty state. Preserve the
   chosen quote/standalone creation source across a successful draft save.

## Verification

Executable repository tests for directory-only identity, canonical precedence,
inactive/missing accounts, yard isolation and migration rollback; date unit tests;
real browser cases covering all edit mechanisms, failed/successful saves, line
layout and decisions. Retain pricing, quantity-review, role and seven-stage tests.
Manual faults exercise directory coverage, minimum date and dirty-button guards;
property tests cover bounded/deduplicated customer search and existing pricing.
Exact production app/worker candidates tested before scoped deploy. Read-only
live check must find 600020/7988, with health/assets/auth and feature gate preserved.

## Visible regression-contract updates

The old enquiry-date test now expects Toronto today, following the user's corrected
SO-placement anchor. Browser flow fixtures use the new default conversion 1 instead
of entering 12; expected native quantities/rates change while quoted subtotals and
SCM review assertions remain. Existing stored conversion 12 has its own retention
case. The quote-source error test saves the changed draft before creating, preserving
its original error/selection-retention assertion. One new fixture initially reused
a unique canonical account number across two IDs; the fixture now uses distinct
account numbers without changing its assertions.
