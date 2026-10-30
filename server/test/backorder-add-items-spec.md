# Backorder Add item correction

Spec approval: not separately obtained; autonomous follow-up to the user's
requested Add item behavior and approved deployment.

1. Active, pre-order Backorders show the same purple Add item button and warning
   dialog as Special Order. Cancel and Escape save nothing. Closed/completed or
   order-linked requests and requests with an operation in progress stay locked.
2. Sales can append regular inventory materials using the existing Backorder
   item search, native quantities, vendor and destination fields. Existing lines,
   prices, stock reviews, decisions and header fields are preserved.
3. Submission returns the request to New enquiry (its initial SCM review stage),
   including requests waiting for information. Superseded request-level review
   markers are retained in the audit event. New lines require SCM review.
4. The authenticated Sales role, yard access, current revision and combined
   100-item limit apply. Invalid or repeated submissions write nothing. Existing
   item IDs cannot be submitted as additions. Concurrent updates serialize.
5. The Backorder route remains local; no remote orders or stock reservations are
   created. Other regular and Special Order Add item behavior stays unchanged.

Verify through real HTTP/database and desktop/mobile browser flows in the bounded
disposable test runner. Preserve only concise evidence and deployment records;
remove all temporary test containers, databases, networks, logs and artifacts.

Display clarification from the existing status implementation: the Backorder
workflow stage is `new_enquiry`; the user-facing unified status is **Pending
SCM**, with Review required. Assert both the stored stage and the displayed
status. The confirmation names both so it matches the existing status badge.
