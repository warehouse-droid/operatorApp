# NetSuite default descriptions and the authorized CMB26105 rate test

Tier 3: pricing and reconciliation. Spec approval: user explicitly requested
the $1 CM test and NetSuite default descriptions; detailed executable spec not
separately approved (autonomous run). No dependencies or commits will be added.

- New version-5 CM intents omit description on every stock, fee, and pallet row.
  NetSuite supplies its normal description. SO reference and operator memo remain.
- Version-4 and older intents retain their historical payload/verification.
  Return Authorization behavior is unchanged.
- Default descriptions may vary without breaking version-5 verification. Identity,
  ordered items, rates, quantities, units, reasons, location, and fee remain exact.
- A rate correction is a separate verified event bound to one existing CM and
  the complete original immutable intent. It changes only explicitly listed stock
  rates and selects default descriptions; fee percentage and all other data stay.
- Unverified, malformed, stale, foreign-CM, duplicate-index, negative/nonfinite,
  or non-stock corrections cannot authorize a mismatch. No correction means the
  original price verification still applies.
- The correction's actual CM amounts and structural fields must pass verification
  before its event is recorded. Subsequent reconciliation uses that event and
  preserves the original submission. No new return, source SO edit, or SMS.
- For RB-000040/CMB26105: update existing stock line 1 to rate 1, quantity 11.66;
  existing fee line 4 to the app-calculated -4.08. Restore the exact NetSuite item
  defaults (blank is allowed for the fee). Verify stock amount 11.66, fee -4.08,
  subtotal 7.58, actual tax/total, row identities, and successful app reconciliation.

Failure model: wrong record/row or duplicate inventory is blocked by exact IDs,
fresh readback and row keys; unauthorized price drift by intent-bound audit events;
description regressions by versioned tests; partial remote save by saved rollback
payload and readback before any retry; concurrent reconciliation by the existing
batch advisory lock. Concurrent external NetSuite edits are checked immediately
before applying; NetSuite has no application-owned cross-system transaction.

Use the standard bounded disposable Compose runner with automatic teardown.
Run focused red cases, the complete return regression suite, static checks,
coverage, pricing properties, and deliberate mutants. Retain concise evidence
and operational before/after records only.

Test clarification: fee calculation uses the rounded gross line amount, as the
existing pricing helper documents. The independent property oracle rounds gross
cents before applying 35%. The transport fixture must retain a cloned request
body so simulated NetSuite sourcing cannot modify the captured outbound request.
Reconciliation cases call the actual batch reconciliation entry point; the
ordinary retry entry point intentionally reuses previously verified submissions.
