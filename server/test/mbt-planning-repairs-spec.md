# MBT planning and draft quote repairs — 2026-10-26

Spec approval: not obtained (autonomous run). The user requested all behaviors below;
the 20YD payload was explicitly confirmed as the same 60,000 lb rating as 14YD.

- Switching repeatedly among Delivery, Exchange, Collection and MBR/Agg retains
  all tabs and the correct active state, including background pool patches.
  Ordinary Dispatch tabs retain the same behavior.
- Bin searches handle 205 choices, match number/size/location without case
  sensitivity, hide unavailable bins, retain the selected bin while searching,
  show empty results, and do not submit a route on Enter in the search box.
  Delivery, replacement and transport selectors use the same search control.
- Set live 20YD maximum payload to the existing 14YD value, 27,215 kg (about
  60,000 lb), recording before/after values without changing any other type.
- A garbage quote using a deposit from the bin item's own rate card creates,
  issues, accepts and converts with the same deposit amount and source evidence.
  The legacy workflow-rate deposit link is populated only for that rate version.
- Draft quote edits retain the ID/number, increment revision, and recalculate
  all price, deposit, tax, distance and service-line evidence from authoritative
  configuration. The form restores the original entered values for editing.
- Issued/accepted/converted quotes reject edits. Stale and cross-customer edits
  fail without changes. Retry is idempotent; concurrent edit/issue has one winner;
  validation failures roll back the complete update. Replaced draft charge
  requests are cancelled, retained as history, and cannot become contract charges.

Failure model: incorrect deposits/tax (exact monetary assertions and conversion),
stale or simultaneous edits (revision/race tests), partial writes (rollback test),
wrong customer/issued mutation (adversarial tests), missing audit/history
(database assertions), and an unusable form (real browser interactions).

Setup uses existing Node, PostgreSQL, Playwright, TypeScript, ESLint, c8 and
fast-check in the repository's bounded disposable runner. No new dependencies,
commits or production test data. Keep source tests, concise evidence and deployment
audit; remove test artifacts/containers/databases/networks after every run.

Additional user instruction, 2026-10-26: inspect 40YD and, if its payload is blank,
set it to 80,000 lb. The live field stores whole kilograms; use the existing
conservative conversion (36,287 kg), fence the update by revision and blank value,
and retain the before/after operational audit. Verify the saved value directly.
