# Special workflow pricing and quantity review — 2026-09-24

Spec approval: not obtained (autonomous run under the user's implementation and
deployment instructions). Use old-coder Tier 3 because prices, issued orders and
concurrent approvals are involved. Preserve other workspace edits; take a scoped
release from each current image. Reuse the existing isolated PostgreSQL, browser,
lint, type and property-test tools. No new dependencies or commits are planned.

## Acceptance scenarios

1. Every new enquiry line requires an explicit finite non-negative unit rate.
   Blank, negative, non-numeric, excessive and unsupported-precision values fail
   on the server as well as the form. Zero is an explicit rate; it is not inferred
   from an empty input. Original quantity, unit and rate remain auditable.
2. SO preparation starts with the enquiry quantity, unit and rate. The original
   unit rate is read-only. Sales can apply a 0–100% discount; the server computes
   the resulting rate with decimal rounding, rather than trusting a client rate.
   Discount applies per material line, at up to four percentage decimal places;
   effective rates use six decimal places. Existing ancillary/pallet charges keep
   their separate controls. A rate supplied to a SO request cannot overwrite an
   existing original rate.
3. An edited quantity creates a pending SCM review with old/new quantities, an
   alert on Sales/SCM cards and priority ahead of ordinary cards. SO/PO creation,
   links, skips and Dispatch release cannot bypass an outstanding review. A draft
   remains editable until remote synchronization starts; a revised proposal is
   versioned, and returning to the reviewed quantity clears the draft proposal.
4. SCM can approve or reject a pending pre-SO quantity change. Approval records
   the reviewed quantity; rejection restores the last reviewed quantity. No
   external order is changed for a pre-SO review.
5. After SO issuance Sales submits a quantity-change proposal instead of editing
   an issued order directly. Only SCM can confirm it. Confirmation updates the
   exact existing material lines on SO and PO together as one tracked workflow.
   If PO is not issued yet, its local draft receives the confirmed quantity.
   A PO using a different UOM retains its previous SO-to-PO quantity ratio.
6. A partial or uncertain remote result remains visibly pending/attention. Retry
   rereads and verifies the same exact order lines and desired quantities; it
   cannot duplicate lines or apply a second delta. The review clears only after
   both order updates are verified. Original rates, units, descriptions and
   unrelated lines are unchanged. Concurrent confirms cannot run together.
7. No quantity update proceeds on closed/completed, fulfilled/received/billed or
   actively dispatched orders, or when the exact linked line or its pre-change
   quantity/price has drifted. Missing evidence fails closed. An external edit
   cannot be silently overwritten. A test-skipped request uses local simulation
   only; a mixed real/test pair cannot mutate real orders through test review.
8. Preferred delivery date, when supplied, is at least three working days after
   the Toronto date on which SO creation is attempted, with the creation day
   excluded. Enforce on draft save and again immediately before a new NetSuite
   submission, including estimate transforms and test skips. Recovery of an
   already submitted SO must still work after the date ages. The existing rule
   excludes weekends; a question about public holidays is pending.
9. Existing requests are not assigned fabricated enquiry prices. Existing saved
   SO prices can establish their legacy baseline during migration; a legacy line
   without any price requires an explicitly entered initial rate before SO save,
   which then locks. Existing native-unit mapping, pallets, description sync,
   form recovery/scroll, seven stages, access scopes and test gates remain valid.

## Open unit decision

The original enquiry unit menu uses PLT/LYR/SEC/PCS/EACH; MBBS-Special's configured
NetSuite sales/purchase unit is PC (unit ID 865). Read-only checks of other labels
are blocked by missing Lists → Units permission. The user has been asked whether
new enquiries should use PC directly or retain packaging units with an explicit
conversion. Do not silently transfer a price between different units. Pricing
and review work can proceed independently while this choice is pending.

## Failure model and verification

- Price manipulation/rounding: server-authoritative original rate, bounded
  decimal math, adversarial API inputs, price/discount properties and mutations.
- Lost quantity proposals/stale approvals: request revision locks, durable review
  identity, exact prior/current quantities, HTTP role/yard tests and concurrency.
- One remote update succeeds: persisted approval and baseline plan, idempotent
  target quantities, readback verification, failure/retry and process-lock tests.
- Wrong/duplicate line: SuiteQL unique-key to REST line identity, keyed PATCH,
  full before/after material and ancillary verification, identity-drift tests.
- Dispatch/fulfillment race: prohibit scheduled/used orders and keep a review
  guard on release, check live remote execution evidence before each update.
- Date boundary: Toronto calendar, Friday/weekend/DST cases and submission-time
  validation distinct from recovery.
- Real execution: browser creation/discount/review/error retention plus a local
  backend end-to-end flow with an isolated external boundary; no live NetSuite
  order mutations for testing. Actual production mapping checks are read-only.
- Release: additive migration, private backup, exact scoped image hashes, both
  app/worker checks and live read-only verification. Preserve other active work.

NetSuite update semantics follow Oracle's
[keyed sublist updates](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_1545295601.html)
and [specific SO line updates](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_159795512874.html).
NetSuite's two order records cannot be committed in one local database transaction;
the visible workflow tracks both updates and retries rather than claiming remote
atomicity.

## User clarifications (append-only)

- Exclude Ontario public holidays. Use the province's nine holidays, plus next
  available weekday observances for weekend holidays; do not add Civic Holiday,
  Easter Monday or Remembrance Day. Source:
  [Ontario public holidays](https://www.ontario.ca/document/your-guide-employment-standards-act-0/public-holidays).
  This is the application's business-calendar convention, not a claim about
  mandatory substitute leave dates under employment law.
- Keep packaging units. The initial rate is per requested packaging unit. SO
  preparation retains that unit/quantity/rate and requires an explicit **PC per
  unit** conversion. Native SO quantity is packaging quantity × conversion;
  native rate is the discounted packaging rate ÷ conversion. The original rate
  remains immutable. Show native quantity/rate and preserve the quoted subtotal;
  reject conversions that cannot represent that subtotal to cents at the supported
  six-decimal native-rate precision rather than silently changing the total.
- Discount is available on every enquiry line from the beginning. Default 0%,
  per-line percentage, with calculated per-line subtotal excluding tax. Carry it
  into the SO and allow Sales to adjust the discount before issuance.
- Initial conversion establishes a piece-count baseline. Later changes to either
  packaging quantity or that conversion trigger SCM review. After issuance the
  conversion is locked and quantity changes use the recorded conversion.

## Regression contract clarification

Existing regression fixtures now supply the newly required enquiry rate and the
explicit packaging conversion; their prior native order quantities, rates and
assertions are preserved. Clock-sensitive delivery normalization uses a fixed
creation clock so historical dates remain meaningful. Initial enquiry quantities
retain the prior finite-number input contract; native SO quantities still require
six-decimal representability. Existing unpriced enquiries receive an explicitly
entered initial native-unit rate before their first SO save.

The new HTTP gate test initially expected 409 for a disabled workflow. Inspection
of the existing policy confirms its established contract is 404 with
SPECIAL_STOCK_DISABLED; the test now asserts both that status and code. This
corrects the specification without changing the existing API behavior.

## Live NetSuite status contract

A read-only SuiteQL probe returned type-prefixed labels, including `Sales Order :
Pending Fulfillment` and `Purchase Order : Pending Receipt`. The quantity adapter
accepts these and the bare labels used by earlier fixtures. It still rejects
partially executed, billed, cancelled or closed states. This production-format
case was observed failing before the normalization fix was implemented.
