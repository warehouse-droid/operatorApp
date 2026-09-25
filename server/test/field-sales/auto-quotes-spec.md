# Automatic company quotes and simpler details

User authorization: 2026-09-22 requests automatic separation by item company,
no Bill To/Ship To/Expected Close input, automatic today date and configurable
validity defaulting to one month. Implementation proceeds autonomously; separate
spec approval was not obtained. Default one month means 30 days, as stated in the
progress update, using the existing company validity setting.

Tier 3 failure model: mixed-company money or item leakage, partial batch saves,
duplicate quotes on retry, stale edits overwriting accepted quotes, offline data
loss, changed historical PDFs and quote fields overriding NetSuite billing.

Acceptance criteria:

1. A new quote needs a site, customer and items, without a company selector.
   Autocomplete searches all companies online and in the saved offline catalog.
   MBBS Trade-A and MBT/MBR Trade suggestions remain, with editable line prices.
2. Items automatically group into MBBS/MBT/MBR summaries. Save creates exactly
   one independent quote per represented company, with its own PDF/confirmation.
   Zero items cannot create an unidentified quote. Existing single-company
   quotes remain editable; adding another company's item creates that additional
   quote while updating the original. Removing all original items retains an
   empty original draft rather than deleting history.
3. The batch saves atomically using stable per-company IDs and the existing
   actor-bound command receipts. Invalid/stale/confirmed member => no members
   saved. Same-command concurrent retries => no extra quotes/revisions. Offline
   batches survive reload and sync; failed batches support review without
   discarding originals or pretending unaccepted edits were confirmed.
4. Quote date is the current Toronto date at save, regardless of supplied form
   date. Expiry is that date plus the issuing company's configured validityDays
   (default 30). These fields are display-only. Historical snapshots keep dates.
5. No Bill To, Ship To or Expected Close controls in the quote editor. New PDFs
   omit those fields but retain customer/contact, jobsite, date, expiry, items,
   exact totals, memo and signatures. Old snapshots/PDFs remain unchanged.
6. New Sales Order intents use the NetSuite customer's sourced billing address;
   the quote cannot replace it. Shipping still derives from the linked jobsite.
   New-customer billing continues to be maintained in the customer directory.
7. Preserve role checks, confirmation immutability, recovery history, pricing,
   visits, imports and the disabled live NetSuite submission gate.

Setup: reuse the pinned isolated Node/Postgres/browser image and existing lint,
types, c8, fast-check and manual mutation tooling. No runtime dependency or DB
migration. Capture a source baseline, add batch/dates properties and database,
PDF, RESTlet and browser regressions, then run the full Field Sales suite,
shuffled suite, changed-line coverage and deliberate mutations. Preserve the
dirty shared workspace; no commits/resets. Deploy only verified Field Sales
files over the active app image and check health/assets/config afterward.

Superseded assertions: requiring users to choose company, restricting quote
autocomplete to that company, and displaying editable quote address/date fields.
Existing backend single-company save validation remains supported for old queues.
