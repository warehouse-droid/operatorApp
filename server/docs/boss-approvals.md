# BOSS sales order approvals

The phone screen is `/boss`. Administration is `/admin/boss-approvals`; account
emails and the BOSS authority are managed in `/admin/accounts`.

Latest update deployed on **3 October 2026 at 05:16 UTC** to
`https://test.mbbsoperation.com`. BOSS approvals are enabled, all three BOSS
accounts are configured, and Gmail SMTP is configured on the server. Recipient
email addresses are managed in Accounts. This update changes the application
only and needs no new migration. See the
[deployment record](../deployments/boss-search-history-20261003/README.md).

The sender is **MBBS System <warehouse@mrbininc.com>**. The display name appears
as a system notification; the actual sending address remains visible in mail
details. No alternate address is impersonated.

## Enable after deployment

1. The deployed application already has the locked dependencies and migration.
   For a separate installation, install the locked dependencies, apply
   `261_boss_approvals.sql` through the normal migration runner (`npm run migrate`),
   and restart the application and webhook worker with the updated source.
2. Create or select the actual accounts for Tony Tan, Jason Pu and Alex Huang.
   Give each the BOSS authority and a valid email address in Accounts.
3. Open BOSS approval setup and map each identity to its account and **verified
   NetSuite Sales Owner internal ID**. Use verified IDs when configuring a new
   installation; the current server already has all three mappings.
4. Configure Gmail SMTP on the server, following company Workspace policy:

   ```dotenv
   BOSS_SMTP_HOST=smtp.gmail.com
   BOSS_SMTP_PORT=587
   BOSS_SMTP_USER=warehouse@mrbininc.com
   BOSS_SMTP_FROM=warehouse@mrbininc.com
   BOSS_SMTP_PASSWORD=
   ```

   Supply an approved SMTP credential securely as `BOSS_SMTP_PASSWORD`; do not
   put it in the Accounts email field or source control. `APP_BASE_URL` must be
   the correct application URL for email links. SMTP uses mandatory TLS. The
   current server's credential was configured separately and is retained by
   application releases.
5. Enable BOSS approvals in setup. All three account/owner/email mappings must
   be valid. Missing SMTP configuration leaves emails queued; in-app notices
   still work. Check the setup screen's delivery and decision status counts.

## Behavior

- Only Sales Orders, including SOT, enter this approval feature. SOT stays out
  of the existing dispatch/fulfillment intake.
- A new pending request follows a **successfully fetched and committed**
  delayed NetSuite status refresh. The first check is eligible after 10 seconds.
  An unsuccessful read, lost lease, or rolled-back refresh publishes nothing.
- Pending Approval is a successful observation even when the existing refresh
  job records a retry. Its existing eight-attempt schedule is unchanged: initial
  check, then waits of 30 seconds, 2 minutes, 10 minutes, 30 minutes, 2 hours,
  6 hours and 12 hours. Later webhooks can enqueue another refresh. A pending
  approval card is not removed when that retry schedule ends.
- The initial pending-order scan also enqueues delayed checks; it cannot
  publish requests directly. Backfill, decisions, enrichment and email have
  independent workers that poll every 5 seconds, with durable database leases.
- A customer's Sales Owner (`custentity4`) matching one of the three verified
  IDs routes exclusively to that BOSS. Other/missing owners route to all three;
  the first eligible decision wins. An inactive named owner does not fall back
  to a different BOSS. Admin authority alone does not grant BOSS access.
- Cards show the customer's standard `creditLimit` and accounts-receivable
  `balance`, in the customer's currency. Missing amounts remain unavailable.
  This does not use the custom workflow Credit Balance field.
- Accept uses native REST to update `salesOrder.orderStatus` to B. It rechecks
  the order, credit snapshot, owner and authority before sending, including
  after waiting in the shared NetSuite mutation queue. Only an approved
  read-back completes approval. A known failed attempt leaves the request
  pending. An ambiguous outcome is checked again every 30 seconds without
  blindly repeating the write.
- Reject requires no reason. An in-app confirmation identifies the order and
  explains closure. Cancel sends nothing; **Reject and close order** queues a
  native REST PATCH that closes the exact existing item lines (`isClosed=true`).
  The request stays Processing until NetSuite confirms H / Closed. Workflow-locked
  closed records are verified using the REST SuiteQL endpoint, without changing
  the workflow. Ambiguous results are rechecked every 30 seconds without another
  automatic close write. Known failures leave the request pending for review.
  Confirmed closure creates `rejected_closed` history/audit and notifications with
  the original financial snapshot. Legacy local rejections remain distinguishable.
  A verified departure and later reentry permits a new review cycle.
- All three BOSS users see completed history and receive decision notices.
  Initial request notices go only to eligible approvers. In-app read status
  persists. Mail reads the recipient's current Accounts email before sending.
  Confirmed transient SMTP failures retry with backoff; permanent refusals and
  ambiguous SMTP outcomes remain visible for operational review.
- Phone lists refresh every 30 seconds, or every 3 seconds while confirming a
  decision. Offline decisions are disabled. Each decision is separately
  confirmed; there is no bulk approval.

## Verification and operational limits

Run `bash tools/boss-verify.sh` using the dedicated, disposable Docker test stack.
It uses the existing `mbbs-regular-v2:e2e` image and PostgreSQL 18. For a clean
environment, install the pinned packages and build the image with
`docker build -f Dockerfile.test --target test-e2e -t mbbs-regular-v2:e2e .`.
The script never points at the production database. The test image and tool
versions used for this run are recorded in the evidence report.

See `test-artifacts/boss-approvals/EVIDENCE.md` for results and coverage limits.
The isolated regression tests send no live email and approve no live order. The account's workflow
and integration role may still reject a native approval; the application keeps
the request pending in that case. Native REST cannot make a customer's credit
read and the subsequent Sales Order update one atomic transaction. An unknown
NetSuite/SMTP outcome needs read-back or operational review, not a blind resend.

Oracle documents the native Sales Order status update in
[Use Case For Approving Your Sales Order](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_159795516182.html).
Google describes company SMTP setup in
[Send email from a printer, scanner, or app](https://support.google.com/a/answer/176600?hl=en)
and display names in
[Change the name on your Gmail account](https://support.google.com/mail/answer/8158?hl=en).

## Credit display update — 3 October 2026

Cards, confirmations and history show **Account Credit**, **Current Owed**, and **Credit Balance**. Current Owed is displayed as the negative of outstanding balance plus unbilled orders; Credit Balance is credit limit minus those same two amounts. The order total is not subtracted again. The owed row includes the outstanding/unbilled breakdown. A customer's net credit is displayed with its actual positive sign. Missing unbilled information is unavailable and disables Accept until refreshed. Historical snapshots are retained. Header, tabs and search remain sticky on phone screens.

All six current pending Voyage orders were refreshed through successful delayed status observations after the release. Their account figures were CAD 200,000.00 / −51,745.47 / 148,254.53 at verification time. These are current account figures; they do not use the historical custom credit field on each order.

## Combined search and approval evidence — 3 October 2026

Searching an order number or customer name searches Pending and History together, from either tab. Pending orders remain restricted to the assigned BOSS. Completed history is shared by all three. Selecting a tab or clearing search restores its normal list.

The whole approved card is grey. Its saved figures include Account Credit, Current Owed, Credit Balance, outstanding balance, unbilled orders, currency and order total. Approval stores the durable decision command's snapshot, so NetSuite read-back and subsequent account changes cannot replace what was reviewed. Cards and details show the capture time, approver and completion time. Historical missing data stays unavailable.

Administrators can find BOSS events under **Admin → Audit Log**, filtered by order number, approver, action and date. Actions include `boss.approval.requested`, `boss.approval.approved`, `boss.approval.rejected` (legacy), `boss.approval.rejected_closed` and `boss.approval.resolved_in_netsuite`. Details contain the saved snapshot. Existing events appear automatically; this uses the existing event records without copying them. BOSS History remains the shared view for BOSS accounts; the Admin Audit Log still requires Admin authority.

At deployment the email delivery counter was **18 sent = 6 approval-request events × 3 BOSS recipients**. It counts individual notification deliveries, not orders. These were request-created notices; no approval decisions had been made. There is no change to notification timing or recipients in this update.

Reproduce the focused checks with `bash tools/boss-history-verify.sh` in a clean disposable test stack. See [the evidence report](../test-artifacts/boss-search-history-20261003/EVIDENCE.md) for results and limitations.
