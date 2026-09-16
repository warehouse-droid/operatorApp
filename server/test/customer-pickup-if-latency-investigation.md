# Customer pickup IF latency — 2026-09-16

Read-only investigation of SOB120453 (NetSuite source 993710), completed as
IF153666 (993724). Command: `c388258e-6656-4f68-a92b-c88e4c3562de`.
Two local lines, no photos. No order, fulfillment or application code was changed.

## Actual timing

The recorded operation began at 12:57:24 UTC and local completion finished at
12:58:22 UTC, approximately 58 seconds later.

| Stage | Duration |
| --- | ---: |
| Admission/pre-posting checks, total | 38.246 s |
| Source validation, within admission | 37.818 s |
| Linked transaction lookup, within source validation | 37.812 s |
| Its SuiteQL execution | 32.716 s |
| Its SuiteQL queue wait behind the first source query | 5.093 s |
| Duplicate external-ID check | 4.820 s |
| Actual IF transform/create | 5.815 s |
| Read-back verification | 3.309 s |
| Recovery lookup and second read | 5.648 s |
| Entire posting phase, including duplicate/create/verify/recovery | 19.617 s |
| Local finalization, including statuses, load evidence and audit | **0.255 s** |

Nested stage durations must not be summed with their parent totals. Database
`now()` timestamps refer to transaction start; use the wall-clock timing events
for duration comparisons. The slow source query joins transaction links, source
lines, transaction headers and result lines in `fetchPoToLinkedTransactionsFromNetSuite`.
The logs establish where time was spent; they do not reveal NetSuite's internal
query execution plan or prove why that one query took 32.7 seconds.

## Confirmed application issues

1. **Misleading initial progress.** `confirmFulfillment` renders “Saving local
   loaded status...” for a no-photo pickup, then changes the in-memory text to
   NetSuite fulfillment without rendering before the awaited POST. That POST
   performs source validation synchronously. The old local-saving message stays
   visible for the 38-second NetSuite precheck. The elapsed timer updates only
   its time span. Local order/line updates are not responsible for this delay.
2. **Unnecessary recovery lookup.** A read-only GET of IF153666 returned `id`
   and `tranId` but none of the transaction-type keys accepted by the verifier.
   Passing this actual record to the deployed verifier reproduces
   `OPERATOR_NETSUITE_POSTING_REMOTE_MISMATCH`: “The recovered NetSuite
   transaction has a different transaction type.” Adding the known `IF` type
   from the fulfillment endpoint lets every existing identity/line/quantity
   check pass. The external-ID recovery adapter already adds this type; the
   direct fetch adapter does not. This explains the extra recovery round trip
   after a successful transform and read, costing 5.65 seconds in this example.

## Improvement targets

- Render the correct NetSuite validation phase before sending the admission POST.
- Normalize the known endpoint type consistently before verification, preserving
  source ID, external ID, line identity, quantities and locations checks.
- Profile and optimize the linked-transaction query. Preserve authoritative
  progress and duplicate protection; its exact NetSuite-side bottleneck remains
  unproven from the available logs.

This example does not establish the duration of the user's separate TO creation.
It does establish that actual IF creation was 5.8 seconds; most of the full IF
workflow's wait was in surrounding NetSuite reads. No R2 upload occurred for
this pickup. Filtered timing events and live/workspace source hash comparisons:
`test-artifacts/customer-pickup-if-latency/timings.json`.
