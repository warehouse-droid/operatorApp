# Operator return enhancements, 2026-10-28

Tier 3: credit memo amounts and external customer messages. Spec approval was
not obtained (autonomous run); the user authorized the nine behaviors below.

1. Stock, pallet, and combined returns accept omitted/blank plates; supplied
   plates keep normalization and the 32-character limit.
2. Stock-return quantity values and labels render at least 15px on desktop and
   phone layouts.
3. Stock confirmation is blocked without its required evidence: a header photo
   for good condition, a photo for each selected quality row. A blocked attempt
   shows a floating, specific photo reminder. Pallet photos remain optional.
4. Stock lookup including pallets uses the same fresh customsearch503 report as
   pallet return, without the historical pallet aggregate or unnecessary credit
   identity queries. Admission still rechecks reservations under locks.
5. After a new, verified CM is committed, durably queue one customer confirmation.
   Read the customer's current NetSuite phone and email; prefer a valid phone,
   otherwise a valid email. Deduplicate retries and combined returns, preserve
   uncertain sends, expose missing contact/failure, retry safe failures with bounds.
   Posting must remain successful if notification services fail. No messages for
   drafts, RAs, local-only, rejected/voided or unverified CMs, or historical CMs.
6. Each new good-condition stock CM line (GD/reason 10) is immediately followed
   by Restocking Fee discount item 3015. The configured default is 35%, confirmed
   by existing CMs' ratepercent=-0.35. Snapshot the percentage at admission and
   submit a negative currency amount, rounded half up to cents per line. Pallets
   have no fee. Zero-priced lines get a zero fee; quantities/rates stay unchanged.
7. R1–R5 (reason IDs 5–9) get no fee and use the receiving yard's active child:
   3445 (1) -> 3445 Return (9), 2967 (28) -> 2967 Return (39), 150 (26) ->
   150 Return (42). Also preserve the existing fourth yard: 12441 (15) -> 46.
   Verify the active child and parent in NetSuite before admission; never silently
   substitute a parent for a quality line. The CM header stays at its receiving yard.
8. Stock and combined CM otherRefNum is the original Sales Order's number.
   Pallet-only CMs do not invent a Sales Order reference.
9. Both return types' new CM memo begins with the authenticated operator username,
   followed by the existing return references, yard, optional plate and notes.

Failure model: incorrect sign/rounding or adjacency (generated amounts and hostile
readback); parent-yard stock misposting (child/parent contract and payload checks);
duplicate messages/credits (concurrency, persisted identities and retry tests);
rollback after sending (post-commit queue, durable delivery reservation); contact
or provider outages (bounded retry, no contact and uncertain outcomes); accidental
history rewrites (old intents retain their payload and verification behavior).

Setup: no dependencies, commits, or branch changes. Preserve existing workspace
edits. Use the repository's isolated runner, mbbs-tests.slice, and its teardown
and unique MBBS_TEST_ARTIFACT_DIR. Persist only source tests and concise evidence;
remove disposable output. Capture only this task's source delta for a release over
the current live image. All tests use synthetic contacts and mocked providers.

Validation: affected return suite plus real HTTP/DOM execution, ESLint, targeted
types, coverage, generated accounting properties, and 3–5 manual mutants. Report
baseline failures and skipped layers explicitly. Unrelated whole-app suites are
outside this change's validation boundary.

10. Added by the user during implementation: stock CM prices use the exact source
    Sales Order line rate and sales units, including custom prices. Set the CM
    stock line price level to Custom (-1) so item defaults cannot replace that
    rate. Restocking fees use this same gross returned value. Readback must reject
    a substituted standard item rate. No item-price lookup may determine the CM rate.
