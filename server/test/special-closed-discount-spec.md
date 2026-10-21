# Verify closed NetSuite orders with Custom Discount% lines

Spec approval: not obtained (autonomous run). Tier 3; continuation of Special request closure.

Live evidence: SOB121381 is Closed in NetSuite; material and PALLET lines are closed, while item 10716 has line_closed=F, executed=0, billed=0. The current verifier rejected that accounting line. SPREQ-000009 correctly remained locally pending/attention, retaining its saved plan.

Accept a closed, workflow-locked order with Custom Discount% item 10716 whose individual closed flag is unset, only with exact fingerprint, zero execution and billing, and a Closed/Cancelled order status. Require every material and PALLET line closed. Never PATCH a discount line. Keep rejecting reopened, executed, billed or changed records. Resume the existing request journal with zero further NetSuite writes and cancel SPREQ-000009 locally after verification. Protect SPREQ-000006 and SPREQ-000007.

Failure model: treating a physical line as an exempt discount could falsely close a request; allowing an open order could bypass closure. Property tests vary item identity and status plus execution/billing, and existing adapter tests retain full identity/fingerprint checks. Lost-response testing verifies idempotence through the saved plan.

Setup: existing isolated tests/tooling, no dependencies, no schema changes, no commits. Release only the adapter delta over image de3178653d8231024557dbdba394d867a49969220434089dea575966b43ba638. Recovery uses the recorded Sales request and persisted closure review; NetSuite boundary rejects all writes during finalization.
