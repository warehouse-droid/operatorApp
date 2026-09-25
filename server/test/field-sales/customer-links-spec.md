# Customer linking and MBBS quote settings — September 22, 2026

Authorization: implement and deploy the requested changes. Spec approval was not
obtained separately (autonomous run). The MBBS settings work uses the old-coder
Tier 1 configuration scope; Sales Order and financial calculations are unchanged.

## Customer popup behavior

1. Both Record Visit and quote customer management show one autocomplete textbox
   for existing customers and an Add to site button. Selection alone does not link.
2. Search names, business/representative phone and email; exclude inactive and
   already linked customers. Distinguish equal names with contact information.
3. Support keyboard selection; stale search results cannot replace a later search.
   Typing after selection clears the selection. Enter must not submit a visit.
4. Submit links once and refreshes the list. Show contacts without checkboxes.
   The displayed active customers and representatives are recorded with a visit.
5. Remove only unlinks from this site. Retain the directory record, representatives,
   other site links and historical visit contact snapshots.
6. Preserve unsaved notes, revisit date and selected photo through link changes and
   representative editing. Offline changes synchronize before their visit/photo.
7. Preserve the existing add-new-customer flow and quote customer selection.

## MBBS configuration acceptance criteria

1. Use QuoteSample.pdf company details and read-only current NetSuite records to
   populate MBBS settings. Record exact sources and before/after values.
2. Location 3445 must resolve to active NetSuite location ID 1; do not store the
   display code 3445 as an internal ID.
3. No default customer ID in company settings. Keep quote customer selection and
   per-customer account resolution when creating Sales Orders. Never copy the
   reference quote's customer into company defaults.
4. Preserve MBT/MBR settings, validity policy, existing quote snapshots, customers,
   other settings and server posting gates. No external record writes or test
   transactions in NetSuite.
5. Apply the MBBS update in a database transaction, requiring an unchanged settings
   revision; audit it as an operational change, without impersonating a staff user.
6. Keep a private rollback copy. Rehearse rollback before committing. Read back the
   persisted profile and render its PDF using the saved template values.

## Setup and verification

Use the existing pinned Docker test image and disposable PostgreSQL database;
existing Node, Playwright, ESLint, TypeScript and PDF tooling. No new packages,
commits, migrations or external write capabilities. Run the complete Field Sales
suite, lint, desktop/mobile/offline customer browser tests and combined quote
browser regression. Only changed Field Sales assets enter the deployment image.

Failure checks: wrong internal location/customer assignment (live reference reads
and existing order tests); partial or concurrent settings update (transaction,
revision guard and rollback rehearsal); deleted customer/history (browser database
assertions); offline/unsaved data loss (browser queue, photo and form assertions).
