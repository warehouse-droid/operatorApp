# Native NetSuite Special Item order previews — 2026-09-26

Spec approval: not obtained (autonomous run). Tier 3: financial document
confidentiality, external API identity, and concurrent persistent caching.

The user corrected the earlier quantity/documents spec: SO and PO previews must
be the actual PDF printed by NetSuite, not the app's own order template. This
supersedes the earlier local SO/PO renderer and Sales-redacted PO assertions.
The local Field Sales MBBS quote behavior remains required and unchanged.

Acceptance criteria:

1. Fetch the exact linked SO/PO ID through the corresponding read-only RESTlet
   action. NetSuite loads the requested record type and uses `render.transaction`
   with PDF mode and its configured transaction form. No picking-ticket or local
   template fallback, no order creation/update, and no retry of SPREQ-000006.
2. Validate the remote action, identity, PDF type/base64/signature/size. Return
   and persist the original PDF bytes without regeneration or redaction.
3. Reuse the first successful preview on repeat requests and across service
   instances; relevant local order/header changes require another fetch. Old
   locally generated cache entries must never qualify as native PDFs.
4. Authorize every read, including cache hits. Sales may view SO PDFs within
   their yard scope; full native PO PDFs remain SCM-only to protect purchase
   costs. The Sales page hides PO preview and SCM exposes both order previews.
5. Serialize concurrent previews of the same document without locking order
   edits during remote rendering. Reject and do not save a PDF when the local
   order changes during retrieval. Remote failures preserve the prior cache
   but do not serve stale content for a different local snapshot.
6. Preserve quote previews, existing PDF modal/download behavior, existing
   PO-history PDF API, all SO/PO mutation paths, and the quantity-race fix.
7. Actual NetSuite SO support requires publishing the updated RESTlet. Verify
   available deployment access; if absent, supply the tested upload file and
   name that live limitation explicitly. Never claim app deployment updates
   NetSuite-hosted SuiteScript automatically.

Failure model: wrong order/type (contract tests); purchase cost disclosure
(HTTP and UI role tests); legacy cache acceptance or stale races (real Postgres
integration tests); corrupted/oversized response (adversarial properties);
duplicate remote fetch (concurrency test); breaking quote/PO-history behavior
(existing regression tests); external deployment mismatch (live health and PDF
checks); unrelated production drift (scoped image and baseline hashes).

Setup: reuse Node/Postgres, native node:test, fast-check, c8, TypeScript, ESLint,
and Playwright in the existing isolated review environment. No new dependency,
no commit, no transaction writes to NetSuite. Add scoped tests and reproducible
check/live/deploy tooling, capture source hashes, check changed lines and
branches, manually kill at least five plausible mutants, and report baseline
failures separately. Layer deployment over the currently running image only.

Primary API reference: [Oracle render.transaction](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_452452331542.html).

User clarification: SCM previews SO and PO; Sales previews SO only. This confirms
the access boundary above. Preview controls must be at the bottom-right of the
form; verify both role pages and new-request quote controls at 1440px and 390px.

Additional user scope: Sales may request closure after PO issuance only while
neither order is planned by Dispatch. SCM confirms or rejects. Confirmation
closes the linked native SO and PO and then marks both local orders and the case
closed/cancelled. Cards and detail views show SO/PO Dispatch planning status.
This introduces a durable closure-review journal and one migration, reuses the
existing NetSuite REST mutation queue, and requires no new dependency.

Closure acceptance criteria:

8. Sales request is scoped, revision checked and requires a reason; it changes
   only local review state. Issued-PO closure waits for SCM. Unauthorized Sales
   confirmation and Dispatch planning while pending are rejected. Existing
   pre-PO closure behavior remains compatible.
9. Detect planned SO or PO, including split/group children, from persisted
   non-cancelled Dispatch plans, not just the SO's cached planned flag. Display
   per-order state in both role cards and detail. Check while holding the case
   lock, coordinated with Dispatch's existing shared case lock.
10. SCM confirmation rechecks planning and execution, verifies both complete
    order line sets and saves an immutable plan before closing any remote line.
    Close PO then SO by exact REST sublist line IDs; preserve quantities, prices,
    descriptions and links. Require both records' closed readbacks before local
    cancellation; no deletes and no new orders.
11. Partial remote failure stays visibly pending with an error. A retry reads
    current NetSuite state and closes only remaining open lines; a lost response
    must never recreate orders or reopen a closed line. Reject is permitted only
    before any remote close begins. Concurrent SCM confirmations run once.
12. SO status webhooks must not finalize issued-PO closure before PO closure is
    verified. Closure invalidates cached order documents through status changes.
    No live business request is closed as part of testing this feature.

Additional failure model: accidentally closing an unrelated/shared order (exact
full-line contract checks), racing planning (real Postgres lock tests), half-closed
pair (durable journal and recovery tests), execution already started (local and
remote quantity guards), role bypass (authenticated HTTP), and stale planned
badges (persisted-plan projection properties). External NetSuite edits between
read and PATCH cannot be made atomic by the REST API; pre/post verification must
detect conflicts and preserve the pending review rather than claiming success.

Reference: [Oracle close Sales Order REST example](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_159795516182.html).
