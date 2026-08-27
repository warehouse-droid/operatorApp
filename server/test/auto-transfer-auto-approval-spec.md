# Auto Transfer automatic approval

## Scope

This change applies only to SCM **Auto Transfer** proposals. Smart SCM, stock-request transfers, manual Transfer Orders, quantity revision, and reprint workflows keep their existing approval behavior.

## Executable acceptance contract

1. The Auto Transfer NetSuite `POST` opts in to status `B` (Pending Fulfillment), so creation and approval are one idempotent remote mutation.
2. A shared Transfer Order payload does not include `orderStatus` unless the Auto Transfer caller explicitly enables automatic approval.
3. Local `approval_status = approved` is persisted only after the hydrated NetSuite record confirms Pending Fulfillment.
4. Confirmed creation persists `approved_at` and `approved_by`, while `print_job_id` remains null and `print_request_status` remains idle.
5. The Created UI labels this state **Pending user print** and offers **Print Source-yard Ticket** without asking for approval again.
6. Printing still requires quantity verification and an explicit user action. Creation does not fetch a ticket, claim a print generation, queue a print job, or create print history.
7. Quantity, printer, or print-service failures block printing without downgrading a NetSuite approval already confirmed.
8. If NetSuite does not confirm Pending Fulfillment, the proposal becomes attention/failed and is not represented as approved or printable.
9. Retry/recovery uses the existing proposal marker and does not create a duplicate Transfer Order.

## Failure model

- NetSuite accepts the create request but returns an unexpected status.
- A timeout occurs after the remote record is created and recovery finds it by marker.
- Two confirmation requests race for the same proposal.
- Quantity verification fails after approval.
- Printer or picking-ticket configuration is unavailable after approval.
- A future shared caller accidentally inherits Auto Transfer approval.
- A future refactor queues a print during creation or downgrades confirmed approval on print failure.

The focused tests, database rollback harness, coverage threshold, and persisted-source mutation runner enforce these cases without contacting NetSuite or production services.

## Production REST compatibility amendment — 2026-08-25

Production NetSuite rejects `orderStatus: { id: "B" }` during the initial
Transfer Order `POST`. The automatic-approval contract is therefore amended as
follows; these clauses supersede acceptance clauses 1 and 2 above without
changing the user-visible outcome:

1. Auto Transfer creates the NetSuite Transfer Order without an `orderStatus`
   field.
2. As soon as the returned or marker-recovered remote identity is known, the
   application persists that identity before attempting approval.
3. If the remote order is not already Pending Fulfillment, Auto Transfer
   immediately PATCHes that same order to status `B`, then hydrates it again.
4. A timeout or error from the PATCH is reconciled by a read: if NetSuite is
   already Pending Fulfillment, the operation succeeds; otherwise the proposal
   retains the remote identity in Attention/Failed Approval for an idempotent
   retry.
5. A retry with a retained identity must approve that same Transfer Order and
   must never issue another create POST.
6. Local approval is still recorded only after the final hydration confirms
   Pending Fulfillment. Printing remains a separate explicit user action.

The production deployment for this amendment is explicitly authorized without
a database backup. It must not automatically retry an existing real proposal.
